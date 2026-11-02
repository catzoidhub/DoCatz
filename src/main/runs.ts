import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { DcComposeAction, DcComposeProject, DcRun } from '@shared/types';
import { cliInstalled, composeBin } from './cli';
import { composeDirLabel, composeFilesLabel, composeProjectLabel, containerLabels, imagePull } from './docker/ops';
import { dockerHost } from './paths';
import { run } from './proc';

/**
 * Compose runs and image pulls (DoCatz TODO #17): each has a token, its output streams to the window line by line,
 * and Cancel stops it. Compose runs through DoCatz's own docker-compose against the DoCatz engine (DOCKER_HOST), in
 * the compose file's folder, so relative paths and .env files work as they do in a terminal.
 */

const ARGS: Record<DcComposeAction, string[]> = {
  up: ['up', '--detach', '--remove-orphans'],
  down: ['down'],
  restart: ['restart'],
  stop: ['stop'],
  pull: ['pull'],
  build: ['build'],
};

export class Runs {
  private running = new Map<string, { abort: AbortController; run: DcRun }>();
  onChange: (r: DcRun) => void = () => undefined;

  private begin(token: string, title: string): { abort: AbortController; run: DcRun; line: (l: string) => void } {
    if (this.running.has(token)) throw new Error('That run is already going');
    const abort = new AbortController();
    const r: DcRun = { token, title, lines: [], done: false };
    this.running.set(token, { abort, run: r });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const line = (l: string) => {
      r.lines.push(l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      if (r.lines.length > 3000) r.lines.splice(0, r.lines.length - 3000);
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          this.onChange({ ...r, lines: [...r.lines] });
        }, 120);
    };
    this.onChange({ ...r });
    return { abort, run: r, line };
  }

  private end(r: DcRun, error?: string): void {
    r.done = true;
    r.error = error;
    this.running.delete(r.token);
    this.onChange({ ...r, lines: [...r.lines] });
  }

  /** `docker compose -f <files> [-p <project>] <action>` in the first file's folder. */
  async compose(files: string[], project: string | null, action: DcComposeAction, token: string): Promise<void> {
    if (!cliInstalled()) throw new Error('Docker Compose is not installed yet — start the engine once, or install the CLIs in Engine');
    const missing = files.find((f) => !existsSync(f));
    if (missing) throw new Error(`${missing} is not there any more`);
    const title = `${project ?? basename(dirname(files[0]))}: compose ${action}`;
    const { abort, run: r, line } = this.begin(token, title);
    const args = [...files.flatMap((f) => ['-f', f]), ...(project ? ['-p', project] : []), ...ARGS[action]];
    line(`$ docker compose ${args.join(' ')}`);
    const res = await run(composeBin(), args, { cwd: dirname(files[0]), env: { ...process.env, DOCKER_HOST: dockerHost(), COMPOSE_ANSI: 'never', COMPOSE_PROGRESS: 'plain' }, signal: abort.signal, onLine: line });
    this.end(r, abort.signal.aborted ? 'Cancelled' : res.code !== 0 ? `docker compose exited ${res.code}` : undefined);
  }

  async pull(ref: string, token: string): Promise<void> {
    const { abort, run: r, line } = this.begin(token, `Pull ${ref}`);
    try {
      await imagePull(ref, line, abort.signal);
      this.end(r);
    } catch (e) {
      this.end(r, (e as Error).message);
    }
  }

  cancel(token: string): void {
    this.running.get(token)?.abort.abort();
  }
}

/** Compose projects DoCatz runs, with their files from the labels compose sets. */
export async function projects(): Promise<DcComposeProject[]> {
  const byName = new Map<string, DcComposeProject>();
  for (const c of await containerLabels()) {
    const name = c.labels[composeProjectLabel];
    if (!name) continue;
    const p = byName.get(name) ?? { name, files: [], dir: c.labels[composeDirLabel] ?? null, containers: 0, running: 0 };
    p.containers++;
    if (c.state === 'running') p.running++;
    for (const f of (c.labels[composeFilesLabel] ?? '').split(',').map((x) => x.trim()).filter(Boolean)) if (!p.files.includes(f)) p.files.push(f);
    byName.set(name, p);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
