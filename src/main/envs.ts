import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DcProjectEnv } from '@shared/types';
import { composeBin } from './cli';
import { dockerHost } from './paths';
import { isLinux, isWin } from './platform';
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

// ---------------------------------------------------------------- hosts on this computer, seen from a container

/** Inside a container 127.0.0.1 is the container itself: the computer's own services are at host.docker.internal. */
const HOST = 'host.docker.internal';
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;
const SCHEMES = /^(mysql|mariadb|postgres|postgresql|redis|rediss|mongodb|mongodb\+srv|amqp|amqps|smtp|smtps|nats|memcache|memcached)$/i;
/** The app's own address stays as it is (APP_URL, ASSET_URL, VITE_*): that is where a browser reaches it. */
const KEEP = /^(APP_|ASSET_|VITE_)/;

// ---------------------------------------------------------------- the stack's own services

/** What a service is, from its image: a database, a cache, a mail catcher… with the port it listens on inside. */
type Kind = 'postgres' | 'mysql' | 'redis' | 'mongodb' | 'amqp' | 'smtp' | 'memcached' | 'nats';
const KINDS: [Kind, RegExp, number][] = [
  ['postgres', /(^|\/)(postgres|postgis|timescaledb)[^/]*(:|$)/i, 5432],
  ['mysql', /(^|\/)(mysql|mariadb|percona)[^/]*(:|$)/i, 3306],
  ['redis', /(^|\/)(redis|valkey|keydb|dragonfly)[^/]*(:|$)/i, 6379],
  ['mongodb', /(^|\/)mongo[^/]*(:|$)/i, 27017],
  ['amqp', /(^|\/)rabbitmq[^/]*(:|$)/i, 5672],
  ['smtp', /(^|\/)(mailpit|mailhog|mailcatcher|smtp4dev|mailcrab)[^/]*(:|$)/i, 1025],
  ['memcached', /(^|\/)memcached[^/]*(:|$)/i, 11211],
  ['nats', /(^|\/)nats[^/]*(:|$)/i, 4222],
];
const SCHEME_KIND: Record<string, Kind> = { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', redis: 'redis', rediss: 'redis', mongodb: 'mongodb', 'mongodb+srv': 'mongodb', amqp: 'amqp', amqps: 'amqp', smtp: 'smtp', smtps: 'smtp', memcache: 'memcached', memcached: 'memcached', nats: 'nats' };
/** A *_HOST key's kind from its name (DB_HOST: the stack's one database, if it has exactly one). */
function hostKind(key: string, own: OwnServices): Kind | null {
  const k = key.toUpperCase();
  if (/REDIS|VALKEY/.test(k)) return 'redis';
  if (/MAIL|SMTP/.test(k)) return 'smtp';
  if (/MONGO/.test(k)) return 'mongodb';
  if (/RABBIT|AMQP/.test(k)) return 'amqp';
  if (/MEMCACHE/.test(k)) return 'memcached';
  if (/NATS/.test(k)) return 'nats';
  if (/PG|POSTGRES/.test(k)) return 'postgres';
  if (/MYSQL|MARIADB/.test(k)) return 'mysql';
  if (/^(DB|DATABASE)_/.test(k)) {
    const dbs = (['postgres', 'mysql', 'mongodb'] as Kind[]).filter((x) => own.has(x));
    return dbs.length === 1 ? dbs[0] : null;
  }
  return null;
}
/** The stack's own services by kind (the first of each): service name and its port inside the network. */
export type OwnServices = Map<Kind, { service: string; port: number }>;

/** The services of a compose project that are a database, a cache, a mail catcher… (empty when compose can't tell). */
export async function ownServices(files: string[], project: string): Promise<OwnServices> {
  const out: OwnServices = new Map();
  if (!files.length) return out;
  const r = await run(composeBin(), [...files.flatMap((f) => ['-f', f]), '-p', project, 'config', '--format', 'json'], { cwd: dirname(files[0]), env: { ...process.env, DOCKER_HOST: dockerHost() }, timeout: 30_000 });
  if (r.code !== 0) return out;
  const cfg = JSON.parse(r.stdout) as { services?: Record<string, { image?: string; profiles?: string[] }> };
  for (const [name, svc] of Object.entries(cfg.services ?? {})) {
    if (!svc.image || svc.profiles?.length) continue;
    const hit = KINDS.find(([, re]) => re.test(svc.image!));
    if (hit && !out.has(hit[0])) out.set(hit[0], { service: name, port: hit[2] });
  }
  return out;
}

/**
 * The value a key should have inside a container (null: leave it), by DevCatz's rule: a loopback host is the computer,
 * so host.docker.internal — unless the stack runs that kind of service itself, then it is that service.
 */
export function containerValue(key: string, value: string, own: OwnServices = new Map()): string | null {
  if (KEEP.test(key)) return null;
  const v = value.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (/_HOST$/i.test(key) && LOOPBACK.test(v)) {
    const kind = hostKind(key, own);
    return (kind && own.get(kind)?.service) || HOST;
  }
  if (/_(URL|URI|DSN)$/i.test(key)) {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*@)?(\[::1\]|127\.0\.0\.1|localhost)(:\d+)?(?=[/?#]|$)/i.exec(v);
    if (m && SCHEMES.test(m[1])) {
      const svc = own.get(SCHEME_KIND[m[1].toLowerCase()]);
      return v.replace(m[0], svc ? `${m[1]}://${m[2] ?? ''}${svc.service}:${svc.port}` : `${m[1]}://${m[2] ?? ''}${HOST}${m[4] ?? ''}`);
    }
  }
  return null;
}

/** KEY=value pairs of a .env text (comments and blank lines skipped, `export` and quotes dropped). */
function parse(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

/** A copied .env with its loopback hosts pointed at host.docker.internal; `changed` lists the keys. */
export function pointHosts(text: string, own: OwnServices = new Map()): { text: string; changed: string[] } {
  const changed: string[] = [];
  const out = text
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/.exec(line);
      if (!m) return line;
      const next = containerValue(m[2], m[4].replace(/\s+#.*$/, ''), own);
      if (next === null) return line;
      changed.push(m[2]);
      const q = /^(['"])/.exec(m[4].trim())?.[1] ?? '';
      return `${m[1]}${m[2]}${m[3]}${q}${next}${q}`;
    })
    .join('\n');
  return { text: out, changed };
}
const envDir = () => dataDir('env');
const safe = (project: string) => {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error(`“${project}” is not a compose project name`);
  return project;
};
export const envFile = (project: string) => join(envDir(), `${safe(project)}.env`);
const overrideFile = (project: string) => join(envDir(), `${safe(project)}.override.yaml`);

/** Compose's own project name for a file (what `docker compose` uses without -p): its top-level `name:`, else its folder's. */
export const projectNameOf = (file: string) => {
  const own = /^name:\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*(?:#.*)?$/m.exec(readText(file))?.[1];
  return (own ?? basename(dirname(file))).toLowerCase().replace(/[^a-z0-9_-]/g, '');
};

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
export function envCreate(project: string, dir: string | null, from: 'env' | 'example' | 'empty', own: OwnServices = new Map()): DcProjectEnv {
  const s = envState(project, dir);
  let content = `# ${project} in DoCatz — the values its containers get when DoCatz runs them.\n# The project's own .env stays as it is (DevCatz uses it on this computer).\n`;
  const source = from === 'env' ? s.projectEnv : from === 'example' ? s.example : null;
  if (source && dir) {
    // Hosts on this computer (127.0.0.1, localhost) become host.docker.internal — or the stack's own service of that
    // kind: inside a container they would be the container.
    const p = pointHosts(readFileSync(join(dir, source), 'utf8'), own);
    const to = own.size ? `the stack's own services (${[...own.values()].map((x) => x.service).join(', ')}) or ${HOST}` : HOST;
    content += `\n# Started from ${source}${p.changed.length ? `; pointed at ${to} for the containers: ${p.changed.join(', ')}` : ''}\n${p.text}`;
  }
  mkdirSync(envDir(), { recursive: true, mode: 0o700 });
  envWrite(project, content, null);
  return envState(project, dir);
}

/**
 * The values each container should have from DoCatz's .env (loopback hosts pointed as on a run) — compared by the
 * window with what the containers really have, to say which keys are not applied yet.
 */
export function expectedEnv(project: string, own: OwnServices = new Map()): Record<string, string> {
  let file: string;
  try {
    file = envFile(project);
  } catch {
    return {};
  }
  if (!existsSync(file)) return {};
  const vars = parse(readFileSync(file, 'utf8'));
  // ${VAR} / $VAR inside values, as compose fills them in when it reads an env_file.
  const fill = (v: string) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, def, b) => vars.get(a ?? b) ?? def ?? '');
  const out: Record<string, string> = {};
  for (const [k, v] of vars) {
    const filled = fill(v);
    out[k] = containerValue(k, filled, own) ?? filled;
  }
  return out;
}

/** Keys each service sets under `environment:` in its compose file — those win over any env_file, by design. */
export async function composeEnvironmentKeys(files: string[], project: string): Promise<Record<string, Set<string>>> {
  if (!files.length) return {};
  const r = await run(composeBin(), [...files.flatMap((f) => ['-f', f]), '-p', project, 'config', '--format', 'json', '--no-interpolate'], { cwd: dirname(files[0]), env: { ...process.env, DOCKER_HOST: dockerHost() }, timeout: 30_000 });
  if (r.code !== 0) return {};
  const cfg = JSON.parse(r.stdout) as { services?: Record<string, { environment?: Record<string, unknown> | string[] }> };
  const out: Record<string, Set<string>> = {};
  for (const [name, svc] of Object.entries(cfg.services ?? {})) {
    const env = svc.environment ?? {};
    out[name] = new Set(Array.isArray(env) ? env.map((e) => e.split('=')[0]) : Object.keys(env));
  }
  return out;
}

export function envSetLocked(project: string, on: boolean): void {
  store.setExtra(LOCK_KEY, { ...(store.extra<Record<string, boolean>>(LOCK_KEY) ?? {}), [safe(project)]: on });
}

export function envRemove(project: string): void {
  rmSync(envFile(project), { force: true });
  rmSync(join(envDir(), `${safe(project)}.hosts.env`), { force: true });
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
  const own = existsSync(file);
  // The project's .env (read by its own env_file / compose) with the DoCatz values on top: every loopback host among
  // them goes to the containers as host.docker.internal, in a last env_file that wins (DevCatz does the same).
  const merged = new Map([...parse(readText(join(dirname(files[0]), '.env'))), ...(own ? parse(readFileSync(file, 'utf8')) : [])]);
  const stack = await ownServices(files, project).catch(() => new Map() as OwnServices);
  const pointed = [...merged].map(([k, v]) => [k, containerValue(k, v, stack)] as const).filter((x): x is readonly [string, string] => x[1] !== null);
  const hostsFile = join(envDir(), `${safe(project)}.hosts.env`);
  if (pointed.length) writeFileSync(hostsFile, `# Written by DoCatz before each run: hosts on this computer, as containers reach them.\n${pointed.map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
  else rmSync(hostsFile, { force: true });
  const envFiles = [...(own ? [file] : []), ...(pointed.length ? [hostsFile] : [])];
  if (!envFiles.length) return [];
  const r = await run(composeBin(), [...files.flatMap((f) => ['-f', f]), '-p', project, 'config', '--services'], { cwd: dirname(files[0]), env: { ...process.env, DOCKER_HOST: dockerHost() }, timeout: 30_000 });
  const services = r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const subst = own ? ['--env-file', file] : [];
  if (!services.length) return subst;
  const list = envFiles.map((f) => `      - ${JSON.stringify(f)}`).join('\n');
  // Windows: WSL's Docker has no DNS name for the PC (Lima's host resolver gives one on a Mac), so the services that get
  // host.docker.internal also get it as host-gateway, which the engine points at Windows (engine/wsl.ts). Linux's own
  // Docker Engine has no such name either: host-gateway is the docker0 bridge's address there (a service on the host
  // must listen on more than 127.0.0.1 to be reached).
  const gateway = (isWin || isLinux) && pointed.length ? '\n    extra_hosts:\n      - "host.docker.internal:host-gateway"' : '';
  const yaml = `# Written by DoCatz before each run: every service gets ${project}'s DoCatz .env${pointed.length ? ' and the hosts on this computer as containers reach them' : ''}.\nservices:\n${services.map((s) => `  ${JSON.stringify(s)}:\n    env_file:\n${list}${gateway}`).join('\n')}\n`;
  writeFileSync(overrideFile(project), yaml, { mode: 0o600 });
  return [...subst, '-f', overrideFile(project)];
}

const readText = (f: string): string => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
