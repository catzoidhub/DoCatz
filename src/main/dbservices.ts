import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { DcContainer, DcDatabase, DcDbEngine } from '@shared/types';
import { inspect } from './docker/ops';
import { store } from './store';
import { isListening } from './system';

/**
 * Database containers for DBCatz (DoCatz TODO #24), the way DevCatz hands DBCatz its own database services: a
 * services.json in DoCatz's data folder (`dbcatz/services.json`, folder 0700, file 0600 — it carries passwords, read
 * only by this user), with each database container's engine, version, a local address and the user / password its
 * image was started with (POSTGRES_PASSWORD, MYSQL_ROOT_PASSWORD, MONGO_INITDB_ROOT_*, redis --requirepass …).
 *
 * The local address: a port the container publishes on this computer, else one of DoCatz's own — the router forwards
 * 127.0.0.1:<port> in the VM to the container's IP (an nginx stream; Lima and WSL bring it to this computer's
 * 127.0.0.1), so no compose file changes, as the domains need none. The port is the engine's own + 10000 (15432,
 * 13306, 16379 …), the next free one when that is taken, and it stays with the container's name (`<project>/<service>`)
 * so a saved DBCatz connection keeps working after a restart.
 */

const PORTS_KEY = 'dbPorts';

/** Image name → engine, and the port it serves on inside the container. */
const ENGINES: { re: RegExp; engine: DcDbEngine; port: number }[] = [
  { re: /(^|\/)(postgres|postgis\/postgis|pgvector\/pgvector|timescale\/timescaledb[\w-]*|bitnami\/postgresql|supabase\/postgres)(:|@|$)/, engine: 'postgresql', port: 5432 },
  { re: /(^|\/)(mariadb|bitnami\/mariadb)(:|@|$)/, engine: 'mariadb', port: 3306 },
  { re: /(^|\/)(mysql|mysql\/mysql-server|percona|bitnami\/mysql)(:|@|$)/, engine: 'mysql', port: 3306 },
  { re: /(^|\/)(valkey\/valkey|bitnami\/valkey)(:|@|$)/, engine: 'valkey', port: 6379 },
  { re: /(^|\/)(redis|redis\/redis-stack-server|bitnami\/redis)(:|@|$)/, engine: 'redis', port: 6379 },
  { re: /(^|\/)(mongo|mongodb\/mongodb-community-server|bitnami\/mongodb)(:|@|$)/, engine: 'mongodb', port: 27017 },
  { re: /(^|\/)(elasticsearch|elasticsearch\/elasticsearch|docker\.elastic\.co\/elasticsearch\/elasticsearch|opensearchproject\/opensearch)(:|@|$)/, engine: 'elasticsearch', port: 9200 },
];

export const engineOf = (image: string): { engine: DcDbEngine; port: number } | null => {
  const i = image.toLowerCase().replace(/^docker\.io\/(library\/)?/, '');
  return ENGINES.find((e) => e.re.test(i)) ?? null;
};

/** The user / password / database the image was started with, from its environment and command. */
function credentials(engine: DcDbEngine, env: Record<string, string>, cmd: string[]): { user: string; password: string; database: string } {
  const flag = (name: string) => {
    const i = cmd.findIndex((a) => a === name || a.startsWith(`${name}=`));
    return i < 0 ? '' : cmd[i].includes('=') ? cmd[i].slice(cmd[i].indexOf('=') + 1) : (cmd[i + 1] ?? '');
  };
  switch (engine) {
    case 'postgresql':
      return { user: env.POSTGRES_USER || env.POSTGRESQL_USERNAME || 'postgres', password: env.POSTGRES_PASSWORD || env.POSTGRESQL_PASSWORD || '', database: env.POSTGRES_DB || env.POSTGRESQL_DATABASE || env.POSTGRES_USER || 'postgres' };
    case 'mysql':
    case 'mariadb': {
      const root = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD;
      const user = env.MYSQL_USER || env.MARIADB_USER;
      const database = env.MYSQL_DATABASE || env.MARIADB_DATABASE || '';
      // root when its password is known (it sees every database), else the app's user; an empty root password is allowed
      if (root !== undefined || /^(yes|1|true)$/i.test(env.MYSQL_ALLOW_EMPTY_PASSWORD || env.MARIADB_ALLOW_EMPTY_ROOT_PASSWORD || '') || !user) return { user: 'root', password: root ?? '', database };
      return { user, password: env.MYSQL_PASSWORD || env.MARIADB_PASSWORD || '', database };
    }
    case 'redis':
    case 'valkey':
      return { user: env.REDIS_USERNAME || '', password: flag('--requirepass') || env.REDIS_PASSWORD || env.VALKEY_PASSWORD || '', database: '0' };
    case 'mongodb':
      return { user: env.MONGO_INITDB_ROOT_USERNAME || env.MONGODB_ROOT_USER || '', password: env.MONGO_INITDB_ROOT_PASSWORD || env.MONGODB_ROOT_PASSWORD || '', database: env.MONGO_INITDB_DATABASE || '' };
    case 'elasticsearch':
      if (env.OPENSEARCH_INITIAL_ADMIN_PASSWORD) return { user: 'admin', password: env.OPENSEARCH_INITIAL_ADMIN_PASSWORD, database: '' };
      return { user: env.ELASTIC_PASSWORD ? 'elastic' : '', password: env.ELASTIC_PASSWORD || '', database: '' };
    default:
      return { user: '', password: '', database: '' };
  }
}

/** What a container's image was started with, kept per container (an inspect each refresh would be wasteful). */
const seen = new Map<string, { env: Record<string, string>; cmd: string[]; image: string }>();

export interface DbStream {
  /** DoCatz's port on 127.0.0.1 (in the VM, forwarded here). */
  port: number;
  ip: string;
  to: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const servicesFile = () => process.env.DOCATZ_DBCATZ_FILE || join(app.getPath('userData'), 'dbcatz', 'services.json');

let databases: DcDatabase[] = [];
let lastBody = '';

/** The database containers as DBCatz sees them (the UI shows the address and Open in DBCatz). */
export const listDatabases = (): DcDatabase[] => databases;

/**
 * Finds the database containers, gives each a local port, writes services.json and returns the router's streams. A
 * port DoCatz gave out before counts as its own (the router may be listening there), never as taken.
 */
export async function updateDatabases(containers: DcContainer[]): Promise<DbStream[]> {
  const ports = { ...(store.extra<Record<string, number>>(PORTS_KEY) ?? {}) };
  const ours = new Set(Object.values(ports));
  let changed = false;
  const streams: DbStream[] = [];
  const out: DcDatabase[] = [];
  for (const c of containers) {
    if (!seen.has(c.id) && c.state === 'running') {
      const i = await inspect(c.id).catch(() => null);
      if (i) seen.set(c.id, { env: Object.fromEntries((i.Config.Env ?? []).map((e) => [e.split('=')[0], e.slice(e.indexOf('=') + 1)])), cmd: [...(i.Config.Entrypoint ?? []), ...(i.Config.Cmd ?? [])], image: i.Config.Image });
    }
    const info = seen.get(c.id);
    const kind = engineOf(info?.image ?? c.image);
    if (!kind) continue;
    const key = c.domainKey;
    const published = c.ports.find((p) => p.type === 'tcp' && p.private === kind.port && p.public);
    let port = published?.public ?? ports[key];
    if (!published && !port) {
      port = kind.port + 10000;
      while (ours.has(port) || (await isListening('127.0.0.1', port))) port++;
      ports[key] = port;
      ours.add(port);
      changed = true;
    }
    if (!published && c.state === 'running' && c.ip) streams.push({ port: port!, ip: c.ip, to: kind.port });
    const cred = info ? credentials(kind.engine, info.env, info.cmd) : { user: '', password: '', database: '' };
    const tag = (info?.image ?? c.image).split('@')[0].split(':')[1] ?? 'latest';
    out.push({
      id: `docatz-${slug(key)}`,
      containerId: c.id,
      name: c.project ? `${c.service ?? c.name} · ${c.project}` : c.name,
      engine: kind.engine,
      version: tag,
      host: '127.0.0.1',
      port: port!,
      ...cred,
      project: c.project,
      service: c.service,
      running: c.state === 'running',
    });
  }
  for (const id of [...seen.keys()]) if (!containers.some((c) => c.id === id)) seen.delete(id);
  if (changed) store.setExtra(PORTS_KEY, ports);
  databases = out;
  write(out);
  return streams;
}

/** dbcatz/services.json in DevCatz's shape (version 1), plus the compose project / service and the database. */
function write(list: DcDatabase[]): void {
  const services = list.map((d) => ({ id: d.id, name: d.name, engine: d.engine, version: d.version, host: d.host, port: d.port, user: d.user, password: d.password, database: d.database, dataDir: '', socket: '', running: d.running, project: d.project, service: d.service }));
  const body = JSON.stringify(services);
  if (body === lastBody) return;
  try {
    const file = servicesFile();
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    else chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, app: 'DoCatz', written: Date.now(), services }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    lastBody = body;
  } catch (e) {
    console.warn('dbcatz/services.json could not be written:', (e as Error).message);
  }
}
