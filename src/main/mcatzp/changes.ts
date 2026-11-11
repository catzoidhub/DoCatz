import { randomUUID } from 'node:crypto';
import type { ActionDef, ActionContext, CallResult } from '@catzoid/mcatzp-host';
import type { DcComposeAction, DcContainer, DoCatzApi, McatzpAsk, SiblingApp, TaskProgress } from '@shared/types';
// relative: the tests load this file without the @shared alias
import { taskPercent } from '../../shared/task';
import { type EngineReads, envNames, knownSecrets, projectFiles, reply, type Scopes } from './actions';
import { MASK, maskText } from './mask';
import { isLinux } from '../platform';

/**
 * DoCatz's changes for MCatzP (TODO #94): each calls the same `api()` method its UI uses and asks first, in a dialog
 * built here from the real target, never from the assistant's words. "Allow for this session" holds per tool, whatever
 * the call, so only what is low-risk whatever its arguments offers it (starting and stopping); anything that runs new
 * code, edits a file or changes the engine asks every time. There is no terminal and no free command: a command can
 * print a secret in a disguised form (user, 2026-11-04). A client never names a path: compose files are the project's own.
 * Long work answers quickly and goes on, showing in the app as if started there; list_runs tells how it goes.
 */
export const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const S = (description: string, maxLength = 300) => ({ type: 'string', minLength: 1, maxLength, description });
export const PROJECT = S("The compose project's name (see list_projects).");
export const CONTAINER = S("The container's name or id (see list_containers).");
const IMAGE_REF = { type: 'string', minLength: 1, maxLength: 300, pattern: '^[\\w][\\w./:@-]*$', description: 'The image, e.g. postgres:17-alpine.' };
const ENV_NAME = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z_][A-Za-z0-9_.]*$', description: 'The variable\'s name.' };

export type Fact = Extract<McatzpAsk, { kind: 'change' }>['facts'][number];
export interface ChangeAction extends ActionDef {
  /** Only stops work: runs at once, since a dialog would hold up the stopping. Still logged. */
  noDialog?: boolean;
  /** `page`: where DoCatz opens once the user allows it (a route of its own: containers/<name>, project/<name>, engine …). */
  preview(args: Record<string, unknown>): Promise<{ title: string; facts: Fact[]; page: string | null; typeName?: string }>;
}
type Q = Awaited<ReturnType<ChangeAction['preview']>>;

export const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);
const ok = (data: unknown = { done: true }): CallResult => reply(data);
const MASKED = `holds a masked value (${MASK}): that would replace the real one`;

export const NOT_SHARED = (what: string) => `${what} is not shared: the user chooses in DoCatz, Settings → MCatzP.`;

interface FollowLine {
  message: string;
  percent?: number;
  done: boolean;
  error?: string;
}

/** What a client may read of a line of long work: masked first, no path on this computer, then cut. */
export const progressLine = (line: string, known: string[]) =>
  maskText(line, known)
    .replace(/(?<![\w.:/-])\/(?:[^\s/:"']+\/)+[^\s/:"']*/g, '…')
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, '…')
    .slice(0, 200);

/** A task of the app as a line: the percent is the whole job, so it never goes down. */
const taskLine = (t: TaskProgress | null): FollowLine | null =>
  t ? { message: [t.title, t.steps[t.step], t.detail].filter(Boolean).join(': '), percent: taskPercent(t), done: false } : null;

/** Waits for long work while the client can follow it; then answers and the work goes on. */
export async function follow(ctx: ActionContext, line: () => FollowLine | null | Promise<FollowLine | null>, still: string, known: string[] = []): Promise<{ done: boolean; error?: string }> {
  const until = Date.now() + (ctx.progress ? 50_000 : 1_500);
  let last = '';
  for (;;) {
    const s = await line();
    if (s?.done) return { done: true, error: s.error };
    const message = s && ctx.progress ? progressLine(s.message, known) : '';
    if (s && ctx.progress && message !== last) {
      ctx.progress({ message, ...(s.percent !== undefined ? { percent: s.percent } : {}) });
      last = message;
    }
    if (Date.now() >= until || ctx.signal.aborted) return { done: false, error: still };
    await new Promise((r) => setTimeout(r, ctx.progress ? 1000 : 150));
  }
}

export function changeActions(api: DoCatzApi, scopes: Scopes, reads: EngineReads): ChangeAction[] {
  if (!scopes.changes) return [];
  const shared = (c: Pick<DcContainer, 'project'>) => (c.project ? scopes.project(c.project) : scopes.loose);
  const followEngine = (ctx: ActionContext, work: Promise<unknown>, still: string) => {
    let end: FollowLine | null = null;
    work.then(() => (end = { message: '', done: true }), (e: Error) => (end = { message: '', done: true, error: e.message }));
    return follow(ctx, async () => end ?? taskLine((await api.engineState()).task ?? null), still);
  };
  const containerOf = async (ref: unknown): Promise<DcContainer> => {
    const r = String(ref).trim();
    const hit = (await api.containers()).find((c) => c.name === r || c.id === r || (r.length >= 6 && c.id.startsWith(r)));
    if (!hit) throw new Error(`No container ${r} (list_containers shows them)`);
    if (!shared(hit)) throw new Error(NOT_SHARED(hit.project ? `Project ${hit.project}` : `Container ${hit.name}`));
    return hit;
  };
  /** DevCatz keeps its own services running: only it starts and stops them. */
  const notDevcatz = (p: string | null) => {
    if (p && /^devcatz-(gw|svc)-/.test(p)) throw new Error(`${p} is DevCatz's: start and stop it in DevCatz`);
  };
  const projectOf = async (ref: unknown) => {
    const name = String(ref);
    if (!scopes.project(name)) throw new Error(NOT_SHARED(`Project ${name}`));
    notDevcatz(name);
    const p = (await api.projects()).find((x) => x.name === name);
    if (!p) throw new Error(`No project ${name} (list_projects shows them)`);
    return p;
  };
  const resources = () => {
    if (!scopes.resources) throw new Error('Images, volumes, networks and builds are not shared: the user can turn them on in DoCatz, Settings → MCatzP.');
  };

  const volumeOf = async (ref: unknown) => {
    resources();
    const v = (await api.volumes()).find((x) => x.name === String(ref));
    if (!v) throw new Error(`No volume ${String(ref)} (list_volumes shows them)`);
    if (v.project && !scopes.project(v.project)) throw new Error(NOT_SHARED(`Project ${v.project}`));
    return v;
  };
  /** An export or import (volume or images): answers when done, or soon with "still"; the copy goes on in DoCatz. */
  const fileWork = async <T>(ctx: ActionContext, work: Promise<T>, done: (r: T) => unknown): Promise<CallResult> => {
    let end: { r: T } | null = null;
    let error: string | null = null;
    work.then((r) => (end = { r }), (e: Error) => (error = e.message));
    ctx.signal.addEventListener('abort', () => ctx.signal.reason === 'cancelled' && void api.volumeCancel(), { once: true });
    await follow(ctx, () => (end || error ? { message: '', done: true } : (() => {
      const t = reads.tasks().file;
      return t && !t.done ? taskLine(t) : null;
    })()), 'Still copying');
    if (error) throw new Error(error);
    return ok(end ? done((end as { r: T }).r) : { finished: false, note: 'Still copying, or DoCatz is waiting for the user to pick the file: it shows in DoCatz; list_volumes / list_images show the result.' });
  };
  const change = (name: string, title: string, description: string, input: Record<string, unknown>, preview: (a: Record<string, unknown>) => Promise<Q>, run: ActionDef['run'], session = false): ChangeAction => ({ name, title, description, tier: 'change', input, allowSession: session, preview, run });
  const stopper = (name: string, title: string, description: string, input: Record<string, unknown>, run: ActionDef['run']): ChangeAction => ({ name, title, description, tier: 'change', input, noDialog: true, preview: async () => ({ title, facts: [], page: null }), run });

  /** A compose run: it answers as soon as it can, the run goes on and shows on the project's page and in list_runs. */
  const composeTool = (name: string, title: string, action: DcComposeAction, verb: string, description: string, session = false, extra: (p: { name: string; running: number; containers: number }) => Fact[] = () => []): ChangeAction =>
    change(
      name,
      title,
      `${description} It may take a while: the answer comes as soon as it can and the run goes on; list_runs shows how it goes, cancel_run stops it.`,
      OBJECT({ project: PROJECT }, ['project']),
      async (a) => {
        const p = await projectOf(a.project);
        if (!p.files.length) throw new Error(`${p.name} was not started from a compose file DoCatz can find`);
        return { title: `${verb} ${p.name}?`, facts: [...fact('Folder', p.dir), ...fact('Running', `${p.running} of ${p.containers} containers`), ...extra(p)], page: `project/${p.name}` };
      },
      async (a, ctx) => {
        const p = await projectOf(a.project);
        const token = `mcatzp:${p.name}:${randomUUID()}`;
        let failed: string | null = null;
        const known = await knownSecrets(api, reads).catch(() => []);
        void api.composeProject(p.name, action, token).catch((e: Error) => (failed = e.message));
        ctx.signal.addEventListener('abort', () => ctx.signal.reason === 'cancelled' && void api.runCancel(token), { once: true });
        const r = await follow(ctx, () => {
          if (failed) return { message: failed, done: true, error: failed };
          const run = reads.run(token);
          return run ? { message: run.lines.at(-1) ?? run.title, done: run.done, error: run.error } : null;
        }, `Still running: list_runs shows ${p.name}'s run (${token}).`, known);
        if (r.done && r.error) throw new Error(maskText(r.error, await knownSecrets(api, reads)));
        return ok(r.done ? { project: p.name, action, finished: true } : { project: p.name, action, finished: false, run: token, note: r.error });
      },
      session,
    );

  const containerTool = (name: string, verb: string, action: Parameters<DoCatzApi['containerAction']>[1], description: string, session: boolean): ChangeAction =>
    change(
      name,
      `${verb} a container`,
      description,
      OBJECT({ container: CONTAINER }, ['container']),
      async (a) => {
        const c = await containerOf(a.container);
        notDevcatz(c.project);
        return { title: `${verb} ${c.name}?`, facts: [...fact('Project', c.project), ...fact('Image', c.image), ...fact('Now', c.status)], page: `containers/${c.name}` };
      },
      async (a) => {
        const c = await containerOf(a.container);
        notDevcatz(c.project);
        await api.containerAction(c.id, action);
        return ok({ container: c.name, action });
      },
      session,
    );

  const secretName = scopes.secretName;
  const shown = (name: string, value: string) => (secretName(name) ? MASK : value.length > 80 ? `${value.slice(0, 80)}…` : value);
  const parseEnv = (content: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const l of content.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(l);
      if (m) out.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
    }
    return out;
  };
  const quoted = (v: string) => (/[\s#'"$]/.test(v) ? `"${v.replace(/(["\\$])/g, '\\$1')}"` : v);
  /** Sets variables; other lines, their comments and order stay. */
  const merge = (content: string, set: Record<string, string>): string => {
    const lines = content.split(/\r?\n/);
    const left = new Set(Object.keys(set));
    const out = lines.map((l) => {
      const m = /^\s*(export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(l);
      if (!m || !left.has(m[2])) return l;
      left.delete(m[2]);
      return `${m[1] ?? ''}${m[2]}=${quoted(set[m[2]])}`;
    });
    while (out.length && out.at(-1) === '') out.pop();
    for (const k of left) out.push(`${k}=${quoted(set[k])}`);
    return `${out.join('\n')}\n`;
  };
  const envOf = async (project: string) => {
    const s = await api.envState(project, null);
    if (!s.exists) throw new Error(`${project} has no environment file in DoCatz yet: env_create makes one`);
    return api.envRead(project);
  };
  const ENTRIES = { type: 'object', minProperties: 1, maxProperties: 50, propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_.]*$' }, additionalProperties: { type: 'string', maxLength: 5000, pattern: '^[^\\r\\n]*$' }, description: 'Variable name → value.' };
  const noMasked = (set: Record<string, string>) => {
    for (const [k, v] of Object.entries(set)) if (v.includes(MASK)) throw new Error(`${k} ${MASKED}`);
  };

  /** A piece of a compose file changed: find must be the real text, once. Secrets never come back in the question. */
  const composeEdit = async (a: Record<string, unknown>) => {
    const p = await projectOf(a.project);
    const file = projectFiles(p, a.file);
    const text = await api.readText(file);
    const find = String(a.find);
    const to = String(a.replace);
    if (find.includes(MASK) || to.includes(MASK)) throw new Error(`The edit ${MASKED}: name a piece of the file with no masked value in it`);
    const at = text.indexOf(find);
    if (at < 0) throw new Error(`That text is not in ${file.split(/[\\/]/).pop()}: read_compose_file shows the file`);
    if (text.indexOf(find, at + 1) >= 0) throw new Error('That text is there more than once: include the lines around it');
    return { p, file, text, next: text.slice(0, at) + to + text.slice(at + find.length), find, to };
  };

  const list: ChangeAction[] = [
    composeTool('compose_up', 'Up a compose project', 'up', 'Start', 'Starts a project: recreates what changed, without building.', false),
    composeTool('compose_build_up', 'Build and up a compose project', 'build-up', 'Build and start', 'Rebuilds the images, then recreates every container whose image or environment changed.'),
    composeTool('compose_build', 'Build a compose project', 'build', 'Build', 'Rebuilds the images, without starting anything.'),
    composeTool('compose_pull', 'Pull a compose project\'s images', 'pull', 'Pull the images of', 'Pulls the newest images the project names.'),
    composeTool('compose_restart', 'Restart a compose project', 'restart', 'Restart', 'Restarts every container of the project.', true),
    composeTool('compose_stop', 'Stop a compose project', 'stop', 'Stop', 'Stops every container of the project; nothing is removed.', true),
    stopper('cancel_run', 'Stop a compose run or pull', 'Stops a compose run or image pull a client started. What it already did stays.', OBJECT({ run: S('The run, from list_runs.', 200) }, ['run']), async (a) => {
      await api.runCancel(String(a.run));
      return ok({ cancelling: a.run });
    }),

    containerTool('start_container', 'Start', 'start', 'Starts a stopped container.', true),
    containerTool('stop_container', 'Stop', 'stop', 'Stops a running container.', true),
    containerTool('restart_container', 'Restart', 'restart', 'Restarts a container.', true),
    containerTool('pause_container', 'Pause', 'pause', 'Pauses a running container.', true),
    containerTool('resume_container', 'Resume', 'unpause', 'Resumes a paused container.', true),
    containerTool('kill_container', 'Kill', 'kill', 'Kills a container at once, without letting it shut down.', false),
    change(
      'save_container_file',
      'Save a file from a container',
      'Saves a file or folder from a container to this computer as a .tar. The user picks where, in DoCatz\'s own dialog; a client never names a path on this computer.',
      OBJECT({ container: CONTAINER, path: { type: 'string', minLength: 1, maxLength: 1000, pattern: '^/', description: 'The path inside the container.' } }, ['container', 'path']),
      async (a) => {
        const c = await containerOf(a.container);
        return { title: `Save ${String(a.path)} from ${c.name}?`, facts: fact('Then', 'You pick where it goes.'), page: `containers/${c.name}` };
      },
      async (a) => {
        const c = await containerOf(a.container);
        const saved = await api.fileSave(c.id, String(a.path));
        return ok(saved ? { saved: true } : { saved: false, note: 'The user cancelled' });
      },
    ),
    change(
      'open_container_url',
      'Open a container\'s address',
      'Opens a shared container\'s own address in the browser.',
      OBJECT({ container: CONTAINER }, ['container']),
      async (a) => {
        const c = await containerOf(a.container);
        if (!c.url) throw new Error(`${c.name} has no address${c.state === 'running' ? '' : ' while it is not running'}`);
        return { title: `Open ${c.url}?`, facts: fact('Container', c.name), page: null };
      },
      async (a) => {
        const c = await containerOf(a.container);
        if (!c.url) throw new Error(`${c.name} has no address`);
        await api.openUrl(c.url);
        return ok({ opened: c.url });
      },
      true,
    ),
    change(
      'set_domain_name',
      'Rename a container\'s domain',
      'Sets the name in front of .docatz.<tld> for a container; for a compose service it holds for that service. Leave `name` out for the default name.',
      OBJECT({ container: CONTAINER, name: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$', description: 'The new name.' } }, ['container']),
      async (a) => {
        const c = await containerOf(a.container);
        return { title: `Rename ${c.service ?? c.name}'s domain?`, facts: [...fact('Now', c.url), ...fact('To', typeof a.name === 'string' ? `${a.name}.docatz.…` : 'the default name')], page: `project/${c.project ?? ''}` };
      },
      async (a) => {
        const c = await containerOf(a.container);
        await api.setDomainName(c.domainKey, typeof a.name === 'string' ? a.name : null);
        return ok({ container: c.name, name: a.name ?? null });
      },
    ),

    // ---- files
    change(
      'edit_compose_file',
      'Edit a compose file',
      'Replaces one piece of a project\'s compose file, in the project\'s own folder. `find` must be there exactly once, as read_compose_file shows it, with no masked value. It asks every time, showing the change. Compose up or build after to apply it.',
      OBJECT({ project: PROJECT, file: S('Which file, when the project has several (see get_project).', 300), find: { type: 'string', minLength: 1, maxLength: 20_000, description: 'The text to replace.' }, replace: { type: 'string', maxLength: 20_000, description: 'What goes there.' } }, ['project', 'find', 'replace']),
      async (a) => {
        const e = await composeEdit(a);
        const secrets = await knownSecrets(api, reads);
        const show = (t: string, sign: string) => maskText(t, secrets).split('\n').map((l) => `${sign} ${l}`).join('\n');
        return { title: `Edit ${e.file.split(/[\\/]/).pop()}?`, facts: [...fact('Project', e.p.name), { label: 'Change', value: `${show(e.find, '-')}\n${show(e.to, '+')}` }], page: `project/${e.p.name}` };
      },
      async (a) => {
        const e = await composeEdit(a);
        await api.writeText(e.file, e.next);
        return ok({ file: e.file.split(/[\\/]/).pop(), saved: true, note: 'compose_up or compose_build_up applies it' });
      },
    ),

    // ---- a project's environment (#97)
    change(
      'env_show_secret',
      'Show one secret environment value',
      'Shows the value of one secret variable of a project\'s environment file. DoCatz asks the user every time; it can never be allowed for a session, and the value goes to this assistant\'s model provider. Prefer not to read secrets.',
      OBJECT({ project: PROJECT, name: ENV_NAME }, ['project', 'name']),
      async (a) => {
        const p = await projectOf(a.project);
        const env = parseEnv((await envOf(p.name)).content);
        if (!env.has(String(a.name))) throw new Error(`${String(a.name)} is not in ${p.name}'s environment (project_env shows the names)`);
        return { title: `Show ${String(a.name)} once?`, facts: [...fact('Project', p.name), ...fact('Goes to', "this assistant's model provider, and stays in its chat")], page: null };
      },
      async (a) => {
        const p = await projectOf(a.project);
        const v = parseEnv((await envOf(p.name)).content).get(String(a.name));
        if (v === undefined) throw new Error(`${String(a.name)} is not in ${p.name}'s environment`);
        return { text: v };
      },
    ),
    change(
      'env_write',
      'Set environment variables',
      'Sets variables in a project\'s environment file in DoCatz; other lines stay. The dialog shows the difference, with secrets hidden. compose_up applies it. A masked value is refused.',
      OBJECT({ project: PROJECT, set: ENTRIES }, ['project', 'set']),
      async (a) => {
        const p = await projectOf(a.project);
        const set = a.set as Record<string, string>;
        noMasked(set);
        const now = parseEnv((await envOf(p.name)).content);
        const keys = Object.keys(set);
        return {
          title: `Change ${p.name}'s environment?`,
          facts: [
            ...fact('Adds', keys.filter((k) => !now.has(k)).map((k) => `${k}=${shown(k, set[k])}`).join(', ')),
            ...fact('Changes', keys.filter((k) => now.has(k) && now.get(k) !== set[k]).map((k) => `${k}: ${shown(k, now.get(k)!)} → ${shown(k, set[k])}`).join(', ')),
            ...fact('Same', keys.filter((k) => now.get(k) === set[k]).join(', ')),
            ...fact('Then', 'compose up applies it'),
          ],
          page: `project/${p.name}`,
        };
      },
      async (a) => {
        const p = await projectOf(a.project);
        const set = a.set as Record<string, string>;
        noMasked(set);
        const env = await envOf(p.name);
        await api.envWrite(p.name, merge(env.content, set), env.mtime);
        return ok({ project: p.name, set: Object.keys(set), note: 'compose_up applies it' });
      },
    ),
    change(
      'env_create',
      'Create a project\'s environment file',
      'Creates the project\'s environment file in DoCatz: from its .env, its .env.example, or empty.',
      OBJECT({ project: PROJECT, from: { type: 'string', enum: ['env', 'example', 'empty'], description: 'What to start from.' } }, ['project', 'from']),
      async (a) => {
        const p = await projectOf(a.project);
        if ((await api.envState(p.name, p.dir)).exists) throw new Error(`${p.name} already has an environment file in DoCatz: env_write changes it`);
        return { title: `Create ${p.name}'s environment file?`, facts: [...fact('From', a.from === 'env' ? 'its .env' : a.from === 'example' ? 'its .env.example' : 'nothing, empty')], page: `project/${p.name}` };
      },
      async (a) => {
        const p = await projectOf(a.project);
        const s = await api.envCreate(p.name, p.dir, a.from as 'env' | 'example' | 'empty');
        return ok({ project: p.name, exists: s.exists, names: envNames((await api.envRead(p.name)).content) });
      },
    ),
    change(
      'env_lock',
      'Lock a project\'s environment file',
      'Locks or unlocks a project\'s environment file: while locked, DevCatz\'s .env does not replace it.',
      OBJECT({ project: PROJECT, locked: { type: 'boolean', description: 'true locks it.' } }, ['project', 'locked']),
      async (a) => {
        const p = await projectOf(a.project);
        return { title: `${a.locked === true ? 'Lock' : 'Unlock'} ${p.name}'s environment file?`, facts: [], page: `project/${p.name}` };
      },
      async (a) => {
        const p = await projectOf(a.project);
        const s = await api.envLock(p.name, a.locked === true);
        return ok({ project: p.name, locked: s.locked });
      },
    ),

    // ---- images
    change(
      'pull_image',
      'Pull an image',
      'Pulls an image onto the engine. It may take a while: the answer comes as soon as it can and the pull goes on; list_runs shows how it goes, cancel_run stops it.',
      OBJECT({ image: IMAGE_REF }, ['image']),
      async (a) => {
        resources();
        return { title: `Pull ${String(a.image)}?`, facts: [], page: 'images' };
      },
      async (a, ctx) => {
        resources();
        const token = `mcatzp:image:${randomUUID()}`;
        let failed: string | null = null;
        const known = await knownSecrets(api, reads).catch(() => []);
        void api.imagePull(String(a.image), token).catch((e: Error) => (failed = e.message));
        ctx.signal.addEventListener('abort', () => ctx.signal.reason === 'cancelled' && void api.runCancel(token), { once: true });
        const r = await follow(ctx, () => {
          if (failed) return { message: failed, done: true, error: failed };
          const run = reads.run(token);
          return run ? { message: run.lines.at(-1) ?? run.title, done: run.done, error: run.error } : null;
        }, `Still pulling: list_runs shows it (${token}).`, known);
        if (r.done && r.error) throw new Error(r.error);
        return ok(r.done ? { image: a.image, finished: true } : { image: a.image, finished: false, run: token, note: r.error });
      },
    ),

    // ---- the engine
    change('start_engine', 'Start the engine', `Starts the Docker engine${isLinux ? " (this computer's Docker Engine; the system asks for the password, and installs it the first time)" : ''}. It may take a minute: the answer comes as soon as it can; get_engine shows how it goes.`, OBJECT(), async () => ({ title: 'Start the engine?', facts: [], page: 'engine' }), async (_a, ctx) => {
      const r = await followEngine(ctx, api.engineStart(), 'Still starting: get_engine shows how it goes.');
      if (r.done && r.error) throw new Error(r.error);
      return ok(r.done ? { running: true } : { running: false, note: r.error });
    }),
    change('stop_engine', 'Stop the engine', isLinux ? "Stops this computer's Docker Engine (the system service; the system asks for the password): every running container stops with it, and Docker for every other app too." : 'Stops the Docker engine: every running container stops with it.', OBJECT(), async () => {
      const running = (await api.containers().catch(() => [])).filter((c) => c.state === 'running').length;
      return { title: 'Stop the engine?', facts: fact('Stops', `${running} running container${running === 1 ? '' : 's'}`), page: 'engine' };
    }, async () => {
      await api.engineStop();
      return ok({ stopped: true });
    }),
    change('restart_engine', 'Restart the engine', 'Restarts the Docker engine and applies settings waiting for a restart. Every running container stops. It answers once the restart is under way; get_engine shows how it goes.', OBJECT(), async () => {
      const e = await api.engineState();
      return { title: 'Restart the engine?', facts: [...fact('Applies', e.pending.join(', ')), ...fact('Then', 'Running containers stop; those set to restart come back')], page: 'engine' };
    }, async (_a, ctx) => {
      const r = await followEngine(ctx, api.engineRestart(), 'Still restarting: get_engine shows how it goes.');
      if (r.done && r.error) throw new Error(r.error);
      return ok(r.done ? { running: true } : { running: false, note: r.error });
    }),
    stopper('cancel_engine_start', 'Stop starting the engine', 'Stops an engine start that is under way.', OBJECT(), async () => {
      await api.engineCancel();
      return ok({ cancelling: true });
    }),
    change(
      'configure_engine',
      'Change the engine\'s settings',
      'Changes the CPUs, memory, disk size, Rosetta and whether the engine starts with DoCatz. Most apply at the next restart_engine. On Linux only autoStart applies (the system’s Docker Engine uses the whole computer).',
      OBJECT({ cpus: { type: 'integer', minimum: 1, maximum: 128 }, memoryGiB: { type: 'integer', minimum: 1, maximum: 1024 }, diskGiB: { type: 'integer', minimum: 8, maximum: 8192 }, rosetta: { type: 'boolean' }, autoStart: { type: 'boolean' } }),
      async (a) => {
        const st = await api.engineState();
        if (st.backend === 'system' && (a.cpus !== undefined || a.memoryGiB !== undefined || a.diskGiB !== undefined || a.rosetta !== undefined)) throw new Error('On Linux the engine is the system’s Docker Engine: it uses the whole computer, so only autoStart can be set');
        const c = st.config;
        const row = (k: keyof typeof c, label: string) => (a[k] !== undefined && a[k] !== c[k] ? fact(label, `${String(c[k])} → ${String(a[k])}`) : []);
        const facts = [...row('cpus', 'CPUs'), ...row('memoryGiB', 'Memory GB'), ...row('diskGiB', 'Disk GB'), ...row('rosetta', 'Rosetta'), ...row('autoStart', 'At start')];
        if (!facts.length) throw new Error('Those are the settings already (get_engine shows them)');
        return { title: "Change the engine's settings?", facts, page: 'engine' };
      },
      async (a) => {
        const s = await api.engineConfigure(a as Parameters<DoCatzApi['engineConfigure']>[0]);
        return ok({ config: s.config, pending: s.pending });
      },
    ),
    {
      ...change('install_wsl', 'Install WSL', 'Windows: installs WSL 2, which the engine runs in. Windows asks for administrator approval, and a restart finishes it; the user restarts.', OBJECT(), async () => ({ title: 'Install WSL?', facts: fact('Then', 'Windows asks for approval; a restart finishes it'), page: 'engine' }), async () => {
        void api.engineSetupWsl().catch(() => undefined);
        return ok({ installing: true, note: 'get_engine shows how it goes' });
      }),
      platforms: ['win32'],
    },
    change('set_docker_context', 'Use DoCatz as the default engine', 'Makes the `docatz` docker context the current one, or goes back to `default`. It changes what `docker` talks to in every terminal.', OBJECT({ use: { type: 'boolean', description: 'true: DoCatz; false: back to default.' } }, ['use']), async (a) => {
      const e = await api.engineState();
      return { title: a.use === true ? 'Make DoCatz the default engine?' : 'Stop using DoCatz as the default engine?', facts: [...fact('Now', e.context.currentName), ...fact('Holds for', 'every terminal on this computer')], page: 'engine' };
    }, async (a) => {
      const s = await api.contextSet(a.use === true);
      return ok({ context: s.context });
    }),
    change('install_cli', 'Install the Docker command line', "Downloads docker, compose and buildx into DoCatz's own folder.", OBJECT(), async () => ({ title: 'Install docker, compose and buildx?', facts: [], page: 'engine' }), async () => {
      await api.cliInstall();
      return ok({ installed: true });
    }),
    change('set_cli_path', 'Add DoCatz\'s command line to PATH', "Adds DoCatz's bin folder to the PATH of new terminals, or takes it out.", OBJECT({ on: { type: 'boolean', description: 'true adds it.' } }, ['on']), async (a) => ({ title: a.on === true ? "Add DoCatz's docker to PATH?" : "Take DoCatz's docker out of PATH?", facts: fact('Holds for', 'new terminals'), page: 'engine' }), async (a) => {
      const s = await api.cliPath(a.on === true);
      return ok({ inPath: s.cli.inPath });
    }),

    // ---- domains: shared with the other Catzoid apps
    change('set_domains', 'Change the domain settings', 'Changes the ending of local names (the TLD) and whether they use HTTPS. Shared with the other Catzoid apps, so their names change too.', OBJECT({ tld: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9-]*$', description: 'The ending, e.g. localhost.' }, https: { type: 'boolean' } }), async (a) => {
      const d = await api.domains();
      const facts = [...(typeof a.tld === 'string' && a.tld !== d.tld ? fact('Ending', `${d.tld} → ${a.tld}`) : []), ...(typeof a.https === 'boolean' && a.https !== d.https ? fact('HTTPS', `${d.https} → ${a.https}`) : [])];
      if (!facts.length) throw new Error('Those are the settings already (get_domains shows them)');
      return { title: 'Change the domain settings?', facts: [...facts, ...fact('Also', 'Shared with Catzoid apps: their names change too')], page: 'settings/domains' };
    }, async (a) => {
      const d = await api.setDomains({ ...(typeof a.tld === 'string' ? { tld: a.tld } : {}), ...(typeof a.https === 'boolean' ? { https: a.https } : {}) });
      return ok({ tld: d.tld, https: d.https });
    }),
    change('trust_certificate', 'Trust the local certificate', 'Trusts the local certificate authority shared by the Catzoid apps, or removes the trust. The system asks the user.', OBJECT({ on: { type: 'boolean', description: 'true trusts it.' } }, ['on']), async (a) => ({ title: a.on === true ? 'Trust the local certificate?' : 'Stop trusting the local certificate?', facts: fact('Then', 'The system asks you too'), page: 'settings/domains' }), async (a) => {
      const d = await api.caTrust(a.on === true);
      return ok({ trusted: d.ca?.trusted ?? false });
    }),
    change('set_names_without_port', 'Names without a port', 'Forwards ports 443 and 80 so names work without a port, or stops. The system asks for administrator approval.', OBJECT({ on: { type: 'boolean', description: 'true turns it on.' } }, ['on']), async (a) => ({ title: a.on === true ? 'Turn on names without a port?' : 'Turn off names without a port?', facts: fact('Then', 'The system asks for approval'), page: 'settings/domains' }), async (a) => {
      const d = await api.cleanUrls(a.on === true);
      return ok({ namesWithoutPort: d.cleanUrls });
    }),
    change('set_resolver', 'The local name resolver', 'Installs or removes the resolver that makes local names work. The system asks for administrator approval.', OBJECT({ on: { type: 'boolean', description: 'true installs it.' } }, ['on']), async (a) => ({ title: a.on === true ? 'Install the name resolver?' : 'Remove the name resolver?', facts: fact('Then', 'The system asks for approval'), page: 'settings/domains' }), async (a) => {
      const d = await api.resolver(a.on === true);
      return ok({ resolver: d.resolver });
    }),

    // ---- moving from another Docker
    change(
      'migrate_run',
      'Move from another Docker',
      'Copies images and volumes from another Docker engine onto DoCatz\'s; the other keeps them. It may take long: the answer comes as soon as it can and it goes on, showing in Engine. cancel_migrate stops it.',
      OBJECT({ source: { type: 'string', enum: ['docker-desktop', 'orbstack', 'colima', 'rancher', 'podman'], description: 'The engine (see list_migrate_sources).' }, images: { type: 'array', maxItems: 200, items: S('An image from migrate_inventory.') }, volumes: { type: 'array', maxItems: 200, items: S('A volume from migrate_inventory.') } }, ['source']),
      async (a) => {
        resources();
        const images = (a.images as string[] | undefined) ?? [];
        const volumes = (a.volumes as string[] | undefined) ?? [];
        if (!images.length && !volumes.length) throw new Error('Name at least one image or volume (migrate_inventory shows them)');
        const inv = await api.migrateInventory(a.source as Parameters<DoCatzApi['migrateInventory']>[0]);
        for (const i of images) if (!inv.images.some((x) => x.ref === i)) throw new Error(`No image ${i} there (migrate_inventory shows them)`);
        for (const v of volumes) if (!inv.volumes.some((x) => x.name === v)) throw new Error(`No volume ${v} there (migrate_inventory shows them)`);
        const replaced = volumes.filter((v) => inv.volumes.find((x) => x.name === v)?.inDocatz);
        const busy = volumes.filter((v) => inv.volumes.find((x) => x.name === v)?.usedBy);
        return { title: `Copy ${images.length + volumes.length} from ${String(a.source)}?`, facts: [...fact('Images', images.join(', ')), ...fact('Volumes', volumes.join(', ')), ...fact('Adds to', replaced.join(', ') && `${replaced.join(', ')}: already in DoCatz, its files are added to it`), ...fact('In use', busy.join(', ') && `${busy.join(', ')}: a database still writing can be copied half way`)], page: 'engine' };
      },
      async (a, ctx) => {
        resources();
        const images = (a.images as string[] | undefined) ?? [];
        const volumes = (a.volumes as string[] | undefined) ?? [];
        let done = false;
        let failed: string[] | null = null;
        let error: string | null = null;
        void api.migrateRun(a.source as Parameters<DoCatzApi['migrateRun']>[0], images, volumes).then((f) => ((failed = f), (done = true)), (e: Error) => ((error = e.message), (done = true)));
        ctx.signal.addEventListener('abort', () => ctx.signal.reason === 'cancelled' && void api.migrateCancel(), { once: true });
        await follow(ctx, () => (done ? { message: '', done: true } : taskLine(reads.tasks().migrate)), 'Still copying');
        if (error) throw new Error(error);
        return ok(done ? { finished: true, failed } : { finished: false, note: 'Still copying: it shows in DoCatz under Engine; list_images and list_volumes show what has arrived.' });
      },
    ),
    stopper('cancel_migrate', 'Stop moving from another Docker', 'Stops a copy under way. What was copied stays.', OBJECT(), async () => {
      await api.migrateCancel();
      return ok({ cancelling: true });
    }),

    // ---- a volume to a file and back (#102): the user picks the file in DoCatz's own dialog, a client never names a path
    change(
      'export_volume',
      'Export a volume',
      'Saves a volume\'s files as a .tar.gz with a manifest beside it, for a backup or another computer. After Allow, DoCatz asks the user where to save it. The answer comes as soon as it can and the copy goes on; cancel_volume_copy stops it.',
      OBJECT({ volume: S("The volume's name (see list_volumes).") }, ['volume']),
      async (a) => {
        const v = await volumeOf(a.volume);
        const writers = await api.volumeWriters(v.name);
        return { title: `Export volume ${v.name}?`, facts: [...fact('Project', v.project), ...fact('Size', v.size ? `${Math.round(v.size / 1e6)} MB` : null), ...fact('In use', writers.join(', ') && `${writers.join(', ')} running: a database still writing can be copied half way`), ...fact('Then', 'DoCatz asks where to save it')], page: 'volumes' };
      },
      async (a, ctx) => {
        const v = await volumeOf(a.volume);
        return fileWork(ctx, api.volumeExport(v.name), (f) => (f ? { volume: v.name, file: f } : { volume: v.name, saved: false, note: 'The user closed the save dialog' }));
      },
    ),
    change(
      'import_volume',
      'Import a volume',
      'Makes a new volume from an archive (a DoCatz export, or any .tar / .tar.gz). After Allow, DoCatz asks the user for the file. `volume` names the new volume; left out, the name in the archive\'s manifest. An existing volume is never touched here: replace_volume_from_file does that.',
      OBJECT({ volume: { type: 'string', minLength: 2, maxLength: 200, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]+$', description: 'The new volume\'s name.' } }),
      async (a) => {
        resources();
        if (typeof a.volume === 'string' && (await api.volumes()).some((v) => v.name === a.volume)) throw new Error(`A volume named ${a.volume} exists: pick another name, or replace_volume_from_file`);
        return { title: typeof a.volume === 'string' ? `Import a volume as ${a.volume}?` : 'Import a volume?', facts: [...fact('Name', typeof a.volume === 'string' ? a.volume : 'From the archive'), ...fact('Then', 'DoCatz asks for the file')], page: 'volumes' };
      },
      async (a, ctx) => {
        resources();
        const pick = await api.volumeImportPick();
        if (!pick) return ok({ imported: false, note: 'The user closed the file dialog' });
        const name = typeof a.volume === 'string' ? a.volume : pick.name;
        if (pick.taken.includes(name)) throw new Error(`A volume named ${name} exists: call again with another \`volume\`, or replace_volume_from_file`);
        return fileWork(ctx, api.volumeImport(pick.file, name, false), () => ({ volume: name, imported: true, from: pick.fileName }));
      },
    ),
    change(
      'export_images',
      'Export images',
      'Saves one or more images (`docker save`) as a .tar.gz, for an image no registry has, a computer without internet, or a version kept before an update. After Allow, DoCatz asks the user where to save it. The answer comes as soon as it can and the copy goes on; cancel_volume_copy stops it.',
      OBJECT({ images: { type: 'array', minItems: 1, maxItems: 50, items: IMAGE_REF, description: 'Tags (or ids) from list_images.' } }, ['images']),
      async (a) => {
        resources();
        const refs = a.images as string[];
        const all = await api.images();
        const found = refs.map((r) => all.find((i) => i.tags.includes(r) || i.id === r || i.id.replace(/^sha256:/, '').startsWith(r)));
        const missing = refs.filter((_, k) => !found[k]);
        if (missing.length) throw new Error(`No image ${missing.join(', ')} (list_images shows them)`);
        const size = found.reduce((n, i) => n + (i?.size ?? 0), 0);
        return { title: refs.length === 1 ? `Export ${refs[0]}?` : `Export ${refs.length} images?`, facts: [...fact('Images', refs.join(', ')), ...fact('Size', `${Math.round(size / 1e6)} MB before compressing`), ...fact('Then', 'DoCatz asks where to save it')], page: 'images' };
      },
      async (a, ctx) => {
        resources();
        const refs = a.images as string[];
        return fileWork(ctx, api.imageExport(refs), (f) => (f ? { images: refs, file: f } : { images: refs, saved: false, note: 'The user closed the save dialog' }));
      },
    ),
    change(
      'import_images',
      'Import images',
      'Loads the images in an archive (a DoCatz export or any `docker save` tar, plain or gzipped). After Allow, DoCatz asks the user for the file. An image already here with the same tag gets the archive\'s in its place (the old one stays, untagged).',
      OBJECT(),
      async () => {
        resources();
        return { title: 'Import images from a file?', facts: [...fact('Then', 'DoCatz asks for the file'), ...fact('Same tag', 'The archive\'s image takes the tag')], page: 'images' };
      },
      async (_a, ctx) => {
        resources();
        const pick = await api.imageImportPick();
        if (!pick) return ok({ imported: false, note: 'The user closed the file dialog' });
        return fileWork(ctx, api.imageImport(pick.file), (loaded) => ({ imported: true, images: loaded, from: pick.fileName }));
      },
    ),
    stopper('cancel_volume_copy', 'Stop an export or import', 'Stops a volume or images export or import under way. A half-made export file is removed; a new volume half filled is removed too.', OBJECT(), async () => {
      await api.volumeCancel();
      return ok({ cancelling: true });
    }),

    // ---- the list's arrangement
    change('set_project_favorite', 'Favorite a project', 'Stars or unstars a project in the list.', OBJECT({ project: PROJECT, favorite: { type: 'boolean' } }, ['project', 'favorite']), async (a) => {
      if (!scopes.project(String(a.project))) throw new Error(NOT_SHARED(`Project ${String(a.project)}`));
      return { title: `${a.favorite === true ? 'Star' : 'Unstar'} ${String(a.project)}?`, facts: [], page: null };
    }, async (a) => {
      const p = await api.projectPrefs();
      const name = String(a.project);
      await api.setProjectPrefs({ ...p, favorites: a.favorite === true ? [...new Set([...p.favorites, name])] : p.favorites.filter((x) => x !== name) });
      return ok({ project: name, favorite: a.favorite === true });
    }, true),
    change('set_project_group', 'Put a project in a group', "Puts a project in one of the list's groups (made when new), or takes it out when `group` is left out.", OBJECT({ project: PROJECT, group: S('The group\'s name.', 80) }, ['project']), async (a) => {
      if (!scopes.project(String(a.project))) throw new Error(NOT_SHARED(`Project ${String(a.project)}`));
      return { title: typeof a.group === 'string' ? `Put ${String(a.project)} in ${a.group}?` : `Take ${String(a.project)} out of its group?`, facts: [], page: null };
    }, async (a) => {
      const p = await api.projectPrefs();
      const name = String(a.project);
      const group = typeof a.group === 'string' ? a.group : null;
      const groups = p.groups.map((g) => ({ ...g, projects: g.projects.filter((x) => x !== name) }));
      if (group) {
        const g = groups.find((x) => x.name === group);
        if (g) g.projects.push(name);
        else groups.push({ name: group, projects: [name], collapsed: false });
      }
      await api.setProjectPrefs({ ...p, groups });
      return ok({ project: name, group });
    }, true),

    // ---- other Catzoid apps
    change('open_in_dialcatz', 'Open a project in DialCatz', 'Opens DialCatz at its Import from DoCatz for a project. Nothing is imported without the user. False when DialCatz is not installed; install_catzoid_app installs it.', OBJECT({ project: PROJECT, service: S('The API service.', 63) }, ['project']), async (a) => {
      const p = await projectOf(a.project);
      return { title: `Open ${p.name} in DialCatz?`, facts: fact('Service', a.service), page: null };
    }, async (a) => {
      const p = await projectOf(a.project);
      const opened = await api.openSibling('dialcatz', `dialcatz://open?docatz=${encodeURIComponent(p.name)}${typeof a.service === 'string' ? `&service=${encodeURIComponent(a.service)}` : ''}`);
      return ok({ opened });
    }, true),
    change('open_in_dbcatz', 'Open a database in DBCatz', 'Opens DBCatz at a database container, with the user and password it was started with (they never go through the client). False when DBCatz is not installed; install_catzoid_app installs it.', OBJECT({ container: CONTAINER }, ['container']), async (a) => {
      const c = await containerOf(a.container);
      const d = (await api.databases()).find((x) => x.containerId === c.id);
      if (!d) throw new Error(`${c.name} is not a database DoCatz knows (list_databases shows them)`);
      return { title: `Open ${d.name} in DBCatz?`, facts: fact('Engine', d.engine), page: null };
    }, async (a) => {
      const c = await containerOf(a.container);
      const d = (await api.databases()).find((x) => x.containerId === c.id);
      if (!d) throw new Error(`${c.name} is not a database DoCatz knows`);
      return ok({ opened: await api.openSibling('dbcatz', `dbcatz://open?docatz=${encodeURIComponent(d.id)}`) });
    }, true),
    change('install_catzoid_app', 'Install another Catzoid app', 'Downloads the build for this computer of DevCatz, DBCatz or DialCatz from the Catzoid site, checks its SHA-256, installs it and opens it. It may take a while; cancel_catzoid_install stops it.', OBJECT({ app: { type: 'string', enum: ['devcatz', 'dbcatz', 'dialcatz'], description: 'Which app.' } }, ['app']), async (a) => ({ title: `Install ${String(a.app)}?`, facts: fact('From', 'catzoid.com; its SHA-256 is checked'), page: null }), async (a, ctx) => {
      let done = false;
      let error: string | null = null;
      const which = a.app as SiblingApp;
      void api.siblingInstall(which, `${which}://open`).then(() => (done = true), (e: Error) => ((error = e.message), (done = true)));
      ctx.signal.addEventListener('abort', () => ctx.signal.reason === 'cancelled' && void api.siblingInstallCancel(), { once: true });
      await follow(ctx, () => (done ? { message: '', done: true } : taskLine(reads.tasks().sibling)), 'Still installing');
      if (error) throw new Error(error);
      return ok(done ? { installed: true } : { installed: false, note: 'Still installing: the dialog in DoCatz shows it; get_app_info lists it once it is there.' });
    }),
    stopper('cancel_catzoid_install', 'Stop installing a Catzoid app', 'Stops the install under way.', OBJECT(), async () => {
      await api.siblingInstallCancel();
      return ok({ cancelling: true });
    }),

    change('set_theme', 'Change the theme', 'Light, dark or following the system. Shared with Catzoid apps, so they follow.', OBJECT({ theme: { type: 'string', enum: ['system', 'light', 'dark'] } }, ['theme']), async (a) => ({ title: `Use the ${String(a.theme)} theme?`, facts: fact('Also', 'Shared with Catzoid apps'), page: null }), async (a) => {
      await api.setSettings({ theme: a.theme as 'system' | 'light' | 'dark' });
      return ok({ theme: a.theme });
    }, true),
    change('remove_build', 'Remove a build from the history', "Removes one entry from BuildKit's history. Its image and cache stay.", OBJECT({ ref: S("The build's ref (see list_builds).") }, ['ref']), async (a) => {
      resources();
      const b = (await api.builds()).find((x) => x.ref === String(a.ref));
      if (!b) throw new Error(`No build ${String(a.ref)} (list_builds shows them)`);
      return { title: `Remove ${b.name} from the history?`, facts: fact('Stays', 'Its image and cache'), page: 'builds' };
    }, async (a) => {
      resources();
      await api.buildRemove(String(a.ref));
      return ok({ removed: a.ref });
    }, true),

    // ---- DoCatz's own updates
    change('check_for_updates', 'Check for a DoCatz update', 'Asks whether a newer DoCatz is out; get_app_info shows the answer.', OBJECT(), async () => ({ title: 'Check for a DoCatz update?', facts: [], page: null }), async () => {
      const u = await api.updateCheck();
      return ok({ status: u.status, version: u.version ?? null });
    }, true),
    change('download_update', 'Download a DoCatz update', 'Downloads the update get_app_info shows; the user installs it. get_app_info shows how it goes, cancel_update_download stops it.', OBJECT(), async () => {
      const u = await api.updateState();
      if (u.status !== 'available') throw new Error('There is no update to download (check_for_updates asks)');
      return { title: `Download DoCatz ${u.version}?`, facts: fact('Then', 'You install it'), page: null };
    }, async () => {
      void api.updateDownload().catch(() => undefined);
      return ok({ downloading: true });
    }),
    stopper('cancel_update_download', 'Stop downloading a DoCatz update', 'Stops the download under way.', OBJECT(), async () => {
      await api.updateCancel();
      return ok({ cancelling: true });
    }),
    change('skip_update', 'Skip a DoCatz version', 'Stops offering this version.', OBJECT({ version: S('The version.', 40) }, ['version']), async (a) => ({ title: `Skip DoCatz ${String(a.version)}?`, facts: [], page: null }), async (a) => {
      await api.updateSkip(String(a.version));
      return ok({ skipped: a.version });
    }),
    change('set_update_prefs', 'Change how DoCatz updates', 'Whether DoCatz checks for updates by itself and tells the user when it finds one.', OBJECT({ auto: { type: 'boolean', description: 'Check by itself.' }, notify: { type: 'boolean', description: 'Tell the user when a check finds a version.' } }), async (a) => ({ title: 'Change how DoCatz updates?', facts: [...fact('Checks by itself', a.auto), ...fact('Tells you', a.notify)], page: 'settings/updates' }), async (a) => {
      const u = await api.updateConfigure(a as Parameters<DoCatzApi['updateConfigure']>[0]);
      return ok({ settings: u.settings });
    }),
  ];
  return list;
}
