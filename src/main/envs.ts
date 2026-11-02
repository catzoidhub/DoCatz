import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DcProjectEnv } from '@shared/types';
import { composeBin } from './cli';
import { dockerHost } from './paths';
import { run } from './proc';
import { dataDir, store } from './store';

/**
 * Each compose project's own .env in DoCatz (like a Dokploy app's environment): the values the containers get when
 * DoCatz runs them — production-like hosts (`postgres`, `redis`) — while the project's .env stays as DevCatz uses it
 * on this computer (127.0.0.1). Kept in DoCatz's data folder, never in the project:
 *   <data>/env/<project>.env              owner-only (0600) — it holds secrets
 *   <data>/env/<project>.override.yaml    every service gets `env_file: <project>.env`, written before each run
 * DoCatz's compose runs add `--env-file <project>.env` (for ${VAR} in the compose file) and the override (for the
 * containers), so the DoCatz values win over the project's .env without changing it.
 */

const LOCK_KEY = 'envLocked';
const envDir = () => dataDir('env');
const safe = (project: string) => {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error(`“${project}” is not a compose project name`);
  return project;
};
export const envFile = (project: string) => join(envDir(), `${safe(project)}.env`);
const overrideFile = (project: string) => join(envDir(), `${safe(project)}.override.yaml`);

/** Compose's own project name for a folder (what `docker compose` uses without -p). */
export const projectNameOf = (file: string) => basename(dirname(file)).toLowerCase().replace(/[^a-z0-9_-]/g, '');

function locked(project: string): boolean {
  return (store.extra<Record<string, boolean>>(LOCK_KEY) ?? {})[project] !== false;
}

export function envState(project: string, dir: string | null): DcProjectEnv {
  const file = envFile(project);
  const exists = existsSync(file);
  return {
    project,
    exists,
    mtime: exists ? statSync(file).mtimeMs : null,
    locked: locked(project),
    dir,
    projectEnv: dir && existsSync(join(dir, '.env')) ? '.env' : null,
    example: dir ? (['.env.example', '.env.dist', '.env.sample'].find((f) => existsSync(join(dir, f))) ?? null) : null,
  };
}

export function envRead(project: string): { content: string; mtime: number } {
  const file = envFile(project);
  if (!existsSync(file)) return { content: '', mtime: 0 };
  return { content: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs };
}

/** Saves; refuses when the file changed since `mtime` (another window, an editor). */
export function envWrite(project: string, content: string, mtime: number | null): number {
  const file = envFile(project);
  if (mtime !== null && existsSync(file) && Math.abs(statSync(file).mtimeMs - mtime) > 1) throw new Error('The .env changed since you opened it: reload it first');
  if (content.length > 500_000) throw new Error('That .env is too large');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content.endsWith('\n') || !content ? content : `${content}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return statSync(file).mtimeMs;
}

/** A new DoCatz .env: a copy of the project's .env, its .env.example, or empty. */
export function envCreate(project: string, dir: string | null, from: 'env' | 'example' | 'empty'): DcProjectEnv {
  const s = envState(project, dir);
  let content = `# ${project} in DoCatz — the values its containers get when DoCatz runs them.\n# The project's own .env stays as it is (DevCatz uses it on this computer).\n`;
  const source = from === 'env' ? s.projectEnv : from === 'example' ? s.example : null;
  if (source && dir) content += `\n# Started from ${source}\n${readFileSync(join(dir, source), 'utf8')}`;
  mkdirSync(envDir(), { recursive: true, mode: 0o700 });
  envWrite(project, content, null);
  return envState(project, dir);
}

export function envSetLocked(project: string, on: boolean): void {
  store.setExtra(LOCK_KEY, { ...(store.extra<Record<string, boolean>>(LOCK_KEY) ?? {}), [safe(project)]: on });
}

export function envRemove(project: string): void {
  rmSync(envFile(project), { force: true });
  rmSync(overrideFile(project), { force: true });
}

/**
 * The extra compose arguments for a run of `project`: `--env-file` and the override giving every service the DoCatz
 * .env. Empty when the project has none.
 */
export async function composeEnvArgs(files: string[], project: string): Promise<string[]> {
  let file: string;
  try {
    file = envFile(project);
  } catch {
    return [];
  }
  if (!existsSync(file)) return [];
  const r = await run(composeBin(), [...files.flatMap((f) => ['-f', f]), '-p', project, 'config', '--services'], { cwd: dirname(files[0]), env: { ...process.env, DOCKER_HOST: dockerHost() }, timeout: 30_000 });
  const services = r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  if (!services.length) return ['--env-file', file];
  const yaml = `# Written by DoCatz before each run: every service gets ${project}'s DoCatz .env.\nservices:\n${services.map((s) => `  ${JSON.stringify(s)}:\n    env_file:\n      - ${JSON.stringify(file)}`).join('\n')}\n`;
  writeFileSync(overrideFile(project), yaml, { mode: 0o600 });
  return ['--env-file', file, '-f', overrideFile(project)];
}
