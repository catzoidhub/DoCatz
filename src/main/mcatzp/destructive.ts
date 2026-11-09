import { randomUUID } from 'node:crypto';
import type { ActionDef, CallResult } from '@catzoid/mcatzp-host';
import type { DcContainer, DcPruneKind, DoCatzApi } from '@shared/types';
import { knownSecrets, reply, type EngineReads, type Scopes } from './actions';
import { type ChangeAction, CONTAINER, fact, type Fact, follow, NOT_SHARED, OBJECT, PROJECT, S } from './changes';
import { maskText } from './mask';

/**
 * What is really gone (TODO #94): the user types a name, every time, checked again in the main process, and "allow for
 * this session" is never offered. A container counts, though compose makes it again: what it wrote inside is gone. After
 * Allow the app never opens what is being removed. Everything named is looked up first: the facts in the dialog are the
 * real target's.
 */
type Q = { title: string; facts: Fact[]; page: string | null; typeName: string };
const ok = (data: unknown = { done: true }): CallResult => reply(data);
const size = (n: number | null | undefined) => (n === null || n === undefined ? null : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

export function destructiveActions(api: DoCatzApi, scopes: Scopes, reads: EngineReads): ChangeAction[] {
  if (!scopes.changes) return [];
  const typed = (name: string, title: string, description: string, input: Record<string, unknown>, preview: (a: Record<string, unknown>) => Promise<Q>, run: ActionDef['run']): ChangeAction => ({ name, title, description, tier: 'destructive', input, allowSession: false, preview, run });
  const notDevcatz = (p: string | null) => {
    if (p && /^devcatz-(gw|svc)-/.test(p)) throw new Error(`${p} is DevCatz's: remove it in DevCatz`);
  };
  const resources = () => {
    if (!scopes.resources) throw new Error('Images, volumes, networks and builds are not shared: the user can turn them on in DoCatz, Settings → MCatzP.');
  };
  const containerOf = async (ref: unknown): Promise<DcContainer> => {
    const r = String(ref).trim();
    const hit = (await api.containers()).find((c) => c.name === r || c.id === r || (r.length >= 6 && c.id.startsWith(r)));
    if (!hit) throw new Error(`No container ${r} (list_containers shows them)`);
    if (hit.project ? !scopes.project(hit.project) : !scopes.loose) throw new Error(NOT_SHARED(hit.project ? `Project ${hit.project}` : `Container ${hit.name}`));
    notDevcatz(hit.project);
    return hit;
  };
  const projectOf = async (ref: unknown) => {
    const name = String(ref);
    if (!scopes.project(name)) throw new Error(NOT_SHARED(`Project ${name}`));
    notDevcatz(name);
    const p = (await api.projects()).find((x) => x.name === name);
    if (!p) throw new Error(`No project ${name} (list_projects shows them)`);
    return p;
  };

  return [
    typed(
      'compose_down',
      'Take a compose project down',
      'Removes the project\'s containers and networks. With `volumes` its named volumes go too, with all their data. It may take a while; list_runs shows how it goes.',
      OBJECT({ project: PROJECT, volumes: { type: 'boolean', description: 'Remove its volumes too: their data is gone.' } }, ['project']),
      async (a) => {
        const p = await projectOf(a.project);
        if (!p.files.length) throw new Error(`${p.name} was not started from a compose file DoCatz can find`);
        const vols = a.volumes === true ? (await api.volumes()).filter((v) => v.project === p.name) : [];
        return {
          title: a.volumes === true ? `Take ${p.name} down, with its volumes?` : `Take ${p.name} down?`,
          facts: [...fact('Removes', `${p.containers} container${p.containers === 1 ? '' : 's'} and its networks`), ...fact('Volumes', a.volumes === true ? `${vols.map((v) => v.name).join(', ') || 'none'}: their data is gone` : 'stay')],
          page: null,
          typeName: p.name,
        };
      },
      async (a, ctx) => {
        const p = await projectOf(a.project);
        const token = `mcatzp:${p.name}:${randomUUID()}`;
        let failed: string | null = null;
        const known = await knownSecrets(api, reads).catch(() => []);
        void api.composeProject(p.name, a.volumes === true ? 'down-volumes' : 'down', token).catch((e: Error) => (failed = e.message));
        const r = await follow(ctx, () => {
          if (failed) return { message: failed, done: true, error: failed };
          const run = reads.run(token);
          return run ? { message: run.lines.at(-1) ?? run.title, done: run.done, error: run.error } : null;
        }, `Still going: list_runs shows it (${token}).`, known);
        if (r.done && r.error) throw new Error(maskText(r.error, await knownSecrets(api, reads)));
        return ok(r.done ? { project: p.name, down: true } : { project: p.name, down: false, run: token, note: r.error });
      },
    ),
    typed(
      'remove_container',
      'Remove a container',
      'Removes a container and what it wrote outside its volumes. With `volumes` its anonymous volumes go too.',
      OBJECT({ container: CONTAINER, volumes: { type: 'boolean', description: 'Its anonymous volumes too.' } }, ['container']),
      async (a) => {
        const c = await containerOf(a.container);
        return { title: `Remove ${c.name}?`, facts: [...fact('Project', c.project), ...fact('Image', c.image), ...fact('Now', c.status), ...fact('Volumes', a.volumes === true ? 'Its anonymous volumes go too' : 'stay')], page: null, typeName: c.name };
      },
      async (a) => {
        const c = await containerOf(a.container);
        await api.containerRemove(c.id, a.volumes === true);
        return ok({ removed: c.name });
      },
    ),
    typed(
      'remove_image',
      'Remove an image',
      'Removes an image. It can be pulled or built again, but anything only in it is gone. With `force` it goes even when a stopped container uses it.',
      OBJECT({ image: S('The image\'s tag or id (see list_images).'), force: { type: 'boolean', description: 'Even when a stopped container uses it.' } }, ['image']),
      async (a) => {
        resources();
        const r = String(a.image);
        const i = (await api.images()).find((x) => x.tags.includes(r) || x.id === r || x.id.replace(/^sha256:/, '').startsWith(r));
        if (!i) throw new Error(`No image ${r} (list_images shows them)`);
        return { title: `Remove ${i.tags[0] ?? r}?`, facts: [...fact('Size', size(i.size)), ...fact('Used by', i.containers ? `${i.containers} container${i.containers === 1 ? '' : 's'}` : null)], page: null, typeName: i.tags[0] ?? i.id.replace(/^sha256:/, '').slice(0, 12) };
      },
      async (a) => {
        resources();
        const r = String(a.image);
        const i = (await api.images()).find((x) => x.tags.includes(r) || x.id === r || x.id.replace(/^sha256:/, '').startsWith(r));
        if (!i) throw new Error(`No image ${r}`);
        await api.imageRemove(i.tags.includes(r) ? r : i.id, a.force === true);
        return ok({ removed: r });
      },
    ),
    typed(
      'remove_volume',
      'Remove a volume',
      'Removes a volume with all its data.',
      OBJECT({ volume: S("The volume's name (see list_volumes).") }, ['volume']),
      async (a) => {
        resources();
        const v = (await api.volumes()).find((x) => x.name === String(a.volume));
        if (!v) throw new Error(`No volume ${String(a.volume)} (list_volumes shows them)`);
        if (v.project && !scopes.project(v.project)) throw new Error(NOT_SHARED(`Project ${v.project}`));
        return { title: `Remove volume ${v.name}?`, facts: [...fact('Project', v.project), ...fact('Size', size(v.size)), ...fact('Used by', v.containers.join(', ')), ...fact('Data', 'Gone with it')], page: null, typeName: v.name };
      },
      async (a) => {
        resources();
        const v = (await api.volumes()).find((x) => x.name === String(a.volume));
        if (!v) throw new Error(`No volume ${String(a.volume)}`);
        if (v.project && !scopes.project(v.project)) throw new Error(NOT_SHARED(`Project ${v.project}`));
        await api.volumeRemove(v.name);
        return ok({ removed: v.name });
      },
    ),
    typed(
      'remove_network',
      'Remove a network',
      'Removes a network. Docker\'s own networks cannot be removed.',
      OBJECT({ network: S("The network's name (see list_networks).") }, ['network']),
      async (a) => {
        resources();
        const n = (await api.networks()).find((x) => x.name === String(a.network));
        if (!n) throw new Error(`No network ${String(a.network)} (list_networks shows them)`);
        if (n.builtin) throw new Error(`${n.name} is Docker's own: it cannot be removed`);
        return { title: `Remove network ${n.name}?`, facts: [...fact('Project', n.project), ...fact('Containers', n.containers.join(', '))], page: null, typeName: n.name };
      },
      async (a) => {
        resources();
        const n = (await api.networks()).find((x) => x.name === String(a.network));
        if (!n || n.builtin) throw new Error(`No network ${String(a.network)} to remove`);
        await api.networkRemove(n.id);
        return ok({ removed: n.name });
      },
    ),
    typed(
      'prune',
      'Clean up the engine',
      'Removes what nothing uses: stopped containers, unused images, volumes or networks, or the build cache. prune_preview shows what would go.',
      OBJECT({ kind: { type: 'string', enum: ['containers', 'images', 'volumes', 'networks', 'build-cache'], description: 'What to clean up.' } }, ['kind']),
      async (a) => {
        resources();
        const kind = a.kind as DcPruneKind;
        const p = await api.prunePreview(kind);
        if (!p.items.length && !p.total) throw new Error(`Nothing to clean up in ${kind}`);
        const names = p.items.map((i) => i.name);
        return { title: `Clean up ${kind}?`, facts: [...fact('Removes', `${names.slice(0, 20).join(', ')}${names.length > 20 ? ` and ${names.length - 20} more` : ''}`), ...fact('Frees', size(p.total))], page: null, typeName: kind };
      },
      async (a) => {
        resources();
        const r = await api.prune(a.kind as DcPruneKind);
        return ok(r);
      },
    ),
    {
      // Not on Linux, where the engine is the system's Docker Engine (MCatzP 1.0.2 knows 'linux').
      ...typed(
      'reset_engine',
      'Reset the engine',
      'Deletes the VM and its disk: every container, image and volume on this engine, in every project. The next start makes a new one.',
      OBJECT(),
      async () => {
        if (!scopes.all) throw new Error('Reset touches every project: the user shares all of them first, in DoCatz, Settings → MCatzP, or resets in DoCatz');
        const d = await api.diskUsage().catch(() => null);
        return { title: 'Reset the engine?', facts: [...fact('Goes', d ? `${d.containers.count} containers, ${d.images.count} images, ${d.volumes.count} volumes` : 'every container, image and volume'), ...fact('Stays', 'Project folders on this computer')], page: null, typeName: 'reset' };
      },
      async () => {
        await api.engineReset('reset');
        return ok({ reset: true });
      },
    ),
      platforms: ['darwin', 'win32'],
    },
    typed(
      'env_remove_variable',
      'Remove an environment variable',
      'Removes one variable from a project\'s environment file in DoCatz. A secret\'s value cannot be read back.',
      OBJECT({ project: PROJECT, name: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z_][A-Za-z0-9_.]*$', description: "The variable's name." } }, ['project', 'name']),
      async (a) => {
        const p = await projectOf(a.project);
        const name = String(a.name);
        const env = await api.envRead(p.name);
        if (!new RegExp(`^\\s*(?:export\\s+)?${name.replace(/\./g, '\\.')}\\s*=`, 'm').test(env.content)) throw new Error(`${name} is not in ${p.name}'s environment (project_env shows the names)`);
        return { title: `Remove ${name} from ${p.name}?`, facts: fact('Then', 'compose up applies it'), page: null, typeName: name };
      },
      async (a) => {
        const p = await projectOf(a.project);
        const name = String(a.name);
        const env = await api.envRead(p.name);
        const re = new RegExp(`^\\s*(?:export\\s+)?${name.replace(/\./g, '\\.')}\\s*=`);
        const next = env.content.split(/\r?\n/).filter((l) => !re.test(l)).join('\n');
        await api.envWrite(p.name, next, env.mtime);
        return ok({ project: p.name, removed: name });
      },
    ),
    typed(
      'env_remove',
      'Remove a project\'s environment file',
      'Removes the project\'s environment file in DoCatz; the project falls back on its own .env. What only that file held is gone.',
      OBJECT({ project: PROJECT }, ['project']),
      async (a) => {
        const p = await projectOf(a.project);
        if (!(await api.envState(p.name, p.dir)).exists) throw new Error(`${p.name} has no environment file in DoCatz`);
        return { title: `Remove ${p.name}'s environment file?`, facts: fact('Then', 'It falls back on its own .env'), page: null, typeName: p.name };
      },
      async (a) => {
        const p = await projectOf(a.project);
        await api.envRemove(p.name);
        return ok({ project: p.name, removed: true });
      },
    ),
  ];
}
