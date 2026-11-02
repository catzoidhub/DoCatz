import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { innerAddress } from '../webports';
import type { DcContainer, DcContainerDetail, DcContainerState, DcDiskUsage, DcImage, DcLogChunk, DcNetwork, DcPort, DcPruneKind, DcPrunePreview, DcStats, DcVolume } from '@shared/types';
import { demuxer, docker } from './client';
import { frameworkOf } from '../frameworks';

/**
 * What the app does with the engine, on top of the Docker API client: lists shaped for the window, stats, logs,
 * a terminal, files inside a container, prune with a preview, and engine events.
 */

interface ApiPort {
  PrivatePort: number;
  PublicPort?: number;
  Type: 'tcp' | 'udp' | 'sctp';
  IP?: string;
}
interface ApiContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: DcContainerState;
  Status: string;
  Created: number;
  Ports: ApiPort[];
  Labels: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  HostConfig?: { NetworkMode?: string };
  Mounts?: { Type: string; Name?: string }[];
}

const PROJECT = 'com.docker.compose.project';
const SERVICE = 'com.docker.compose.service';
const WORKDIR = 'com.docker.compose.project.working_dir';
const FILES = 'com.docker.compose.project.config_files';

/** One entry per published port (IPv4 and IPv6 bindings of the same port are one). */
function ports(list: ApiPort[]): DcPort[] {
  const seen = new Set<string>();
  const out: DcPort[] = [];
  for (const p of list.sort((a, b) => a.PrivatePort - b.PrivatePort)) {
    const key = `${p.PrivatePort}/${p.Type}/${p.PublicPort ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ private: p.PrivatePort, public: p.PublicPort ?? null, type: p.Type, ip: p.IP ?? '' });
  }
  return out;
}

const health = (status: string): DcContainer['health'] => (/\(healthy\)/.test(status) ? 'healthy' : /\(unhealthy\)/.test(status) ? 'unhealthy' : /health: starting/.test(status) ? 'starting' : null);

export type UrlFor = (c: Omit<DcContainer, 'url'>) => string | null;
/** Custom domain names (Domains keeps them); filled in here so the list shows them. */
export let domainNameOf: (key: string) => string | null = () => null;
export const setDomainNameLookup = (fn: (key: string) => string | null) => (domainNameOf = fn);

function shape(c: ApiContainer, urlFor: UrlFor): DcContainer {
  const base: Omit<DcContainer, 'url'> = {
    id: c.Id,
    name: (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
    image: c.Image.startsWith('sha256:') ? c.Image.slice(7, 19) : c.Image,
    state: c.State,
    status: c.Status,
    health: health(c.Status),
    created: c.Created * 1000,
    project: c.Labels?.[PROJECT] ?? null,
    service: c.Labels?.[SERVICE] ?? null,
    workingDir: c.Labels?.[WORKDIR] ?? null,
    ports: ports(c.Ports ?? []),
    networks: Object.keys(c.NetworkSettings?.Networks ?? {}),
    ip: Object.values(c.NetworkSettings?.Networks ?? {}).map((n) => n.IPAddress).find((x) => !!x) ?? null,
    domainKey: c.Labels?.[PROJECT] && c.Labels?.[SERVICE] ? `${c.Labels[PROJECT]}/${c.Labels[SERVICE]}` : (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
    domainName: null,
    framework: frameworkOf(c.Labels?.[PROJECT] ?? null, c.Labels?.[SERVICE] ?? null),
  };
  base.domainName = domainNameOf(base.domainKey);
  return { ...base, url: urlFor(base), inner: innerAddress(base) };
}

export async function listContainers(urlFor: UrlFor): Promise<DcContainer[]> {
  const list = await docker.get<ApiContainer[]>('/containers/json', { all: true });
  // DoCatz's own router (domains for containers without a published port) is not one of the user's containers.
  return list.filter((c) => !c.Labels?.['com.mrcatz.docatz.router']).map((c) => shape(c, urlFor)).sort((a, b) => (a.project ?? '￿').localeCompare(b.project ?? '￿') || a.name.localeCompare(b.name));
}

/** Raw labels of every container (compose projects and their files). */
export async function containerLabels(): Promise<{ id: string; state: string; labels: Record<string, string> }[]> {
  const list = await docker.get<ApiContainer[]>('/containers/json', { all: true });
  return list.map((c) => ({ id: c.Id, state: c.State, labels: c.Labels ?? {} }));
}

export const composeFilesLabel = FILES;
export const composeProjectLabel = PROJECT;
export const composeDirLabel = WORKDIR;

interface ApiInspect {
  Id: string;
  Name: string;
  Created: string;
  Platform: string;
  RestartCount: number;
  State: { Status: DcContainerState; ExitCode: number; StartedAt: string; FinishedAt: string; Health?: { Status: string } };
  Config: { Image: string; Env: string[] | null; Cmd: string[] | null; Entrypoint: string[] | null; Labels: Record<string, string> | null; Tty: boolean };
  HostConfig: { RestartPolicy?: { Name: string; MaximumRetryCount: number } };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[];
  NetworkSettings: { Networks: Record<string, { IPAddress: string }>; Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
}

export async function inspect(id: string): Promise<ApiInspect> {
  return docker.get<ApiInspect>(`/containers/${encodeURIComponent(id)}/json`);
}

export async function containerDetail(id: string, urlFor: UrlFor): Promise<DcContainerDetail> {
  const i = await inspect(id);
  const listed = (await docker.get<ApiContainer[]>('/containers/json', { all: true, filters: JSON.stringify({ id: [i.Id] }) }))[0];
  const base = listed ? shape(listed, urlFor) : shape({ Id: i.Id, Names: [i.Name], Image: i.Config.Image, ImageID: '', State: i.State.Status, Status: i.State.Status, Created: Date.parse(i.Created) / 1000, Ports: [], Labels: i.Config.Labels ?? {} }, urlFor);
  const quote = (a: string[] | null) => (a ?? []).map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ');
  return {
    ...base,
    command: quote(i.Config.Cmd),
    entrypoint: quote(i.Config.Entrypoint),
    envNames: (i.Config.Env ?? []).map((e) => e.split('=')[0]).sort(),
    mounts: i.Mounts.map((m) => ({ type: m.Type, source: m.Type === 'volume' ? (m.Name ?? m.Source) : m.Source, destination: m.Destination, rw: m.RW })),
    ips: Object.entries(i.NetworkSettings.Networks ?? {}).map(([network, n]) => ({ network, ip: n.IPAddress })),
    restartPolicy: i.HostConfig.RestartPolicy?.Name || 'no',
    restartCount: i.RestartCount,
    exitCode: i.State.Status === 'running' ? null : i.State.ExitCode,
    startedAt: i.State.StartedAt,
    finishedAt: i.State.FinishedAt,
    platform: i.Platform,
    labels: i.Config.Labels ?? {},
  };
}

export async function containerEnv(id: string): Promise<Record<string, string>> {
  const i = await inspect(id);
  return Object.fromEntries((i.Config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=') < 0 ? e.length : e.indexOf('=')), e.includes('=') ? e.slice(e.indexOf('=') + 1) : '']));
}

export async function containerAction(id: string, action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill'): Promise<void> {
  await docker.json('POST', `/containers/${encodeURIComponent(id)}/${action}`, { timeout: 120_000 }).catch((e) => {
    // 304: already started / stopped — nothing to do.
    if ((e as { status?: number }).status !== 304) throw e;
  });
}

export async function containerRemove(id: string, volumes: boolean): Promise<void> {
  await docker.json('DELETE', `/containers/${encodeURIComponent(id)}`, { query: { force: true, v: volumes }, timeout: 120_000 });
}

interface ApiStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op: string; value: number }[] | null };
  pids_stats?: { current?: number };
}

/** One sample per running container (Docker measures over about a second). */
export async function stats(ids: string[]): Promise<DcStats[]> {
  const out = await Promise.all(
    ids.map(async (id) => {
      try {
        const s = await docker.json<ApiStats>('GET', `/containers/${encodeURIComponent(id)}/stats`, { query: { stream: false }, timeout: 10_000 });
        const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
        const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
        const cpus = s.cpu_stats.online_cpus || 1;
        const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
        const net = Object.values(s.networks ?? {});
        const io = s.blkio_stats?.io_service_bytes_recursive ?? [];
        return {
          id,
          cpu: sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0,
          memUsed: Math.max(0, (s.memory_stats.usage ?? 0) - cache),
          memLimit: s.memory_stats.limit ?? 0,
          netRx: net.reduce((a, n) => a + n.rx_bytes, 0),
          netTx: net.reduce((a, n) => a + n.tx_bytes, 0),
          blockRead: io.filter((x) => /read/i.test(x.op)).reduce((a, x) => a + x.value, 0),
          blockWrite: io.filter((x) => /write/i.test(x.op)).reduce((a, x) => a + x.value, 0),
          pids: s.pids_stats?.current ?? 0,
        } satisfies DcStats;
      } catch {
        return null;
      }
    }),
  );
  return out.filter((s): s is DcStats => s !== null);
}

// ---------------------------------------------------------------- logs

/** Follows a container's log; `emit` gets batches of lines (every 100 ms at most). Returns a stop function. */
export async function followLogs(id: string, tail: number, token: string, emit: (c: DcLogChunk) => void): Promise<() => void> {
  const i = await inspect(id);
  const res: IncomingMessage = await docker.stream('GET', `/containers/${encodeURIComponent(id)}/logs`, { query: { follow: true, stdout: true, stderr: true, timestamps: true, tail } });
  let batch: DcLogChunk['lines'] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!batch.length) return;
    emit({ token, lines: batch });
    batch = [];
  };
  const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const add = (stream: 'stdout' | 'stderr', data: Buffer) => {
    const text = partial[stream] + data.toString('utf8');
    const lines = text.split('\n');
    partial[stream] = lines.pop() ?? '';
    for (const l of lines) {
      const sp = l.indexOf(' ');
      batch.push({ stream, time: sp > 0 ? l.slice(0, sp) : '', text: (sp > 0 ? l.slice(sp + 1) : l).replace(/\r$/, '') });
    }
    if (batch.length > 2000) batch = batch.slice(-2000);
    if (!timer) timer = setTimeout(flush, 100);
  };
  const feed = i.Config.Tty ? (c: Buffer) => add('stdout', c) : demuxer(add);
  res.on('data', feed);
  res.on('end', () => {
    flush();
    emit({ token, lines: [], ended: true });
  });
  res.on('error', (e) => emit({ token, lines: [], ended: true, error: e.message }));
  return () => res.destroy();
}

// ---------------------------------------------------------------- exec

/** Runs a command in a container without a terminal and returns its output. */
export async function execRun(id: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const e = await docker.json<{ Id: string }>('POST', `/containers/${encodeURIComponent(id)}/exec`, { body: { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false } });
  const res = await docker.stream('POST', `/exec/${e.Id}/start`, { body: { Detach: false, Tty: false } });
  const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const feed = demuxer((s, d) => out[s].push(Buffer.from(d)));
  await new Promise<void>((resolve, reject) => {
    res.on('data', feed);
    res.on('end', resolve);
    res.on('error', reject);
  });
  const r = await docker.get<{ ExitCode: number }>(`/exec/${e.Id}/json`);
  return { code: r.ExitCode ?? 0, stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8') };
}

/** A terminal in a container: bash when it has one, else sh. */
export async function execTerminal(id: string, cols: number, rows: number): Promise<{ exec: string; socket: Duplex }> {
  const cmd = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];
  const e = await docker.json<{ Id: string }>('POST', `/containers/${encodeURIComponent(id)}/exec`, {
    body: { Cmd: cmd, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env: ['TERM=xterm-256color', `COLUMNS=${cols}`, `LINES=${rows}`] },
  });
  const socket = await docker.hijack(`/exec/${e.Id}/start`, { Detach: false, Tty: true });
  await execResize(e.Id, cols, rows).catch(() => undefined);
  return { exec: e.Id, socket };
}

export async function execResize(exec: string, cols: number, rows: number): Promise<void> {
  await docker.json('POST', `/exec/${exec}/resize`, { query: { h: rows, w: cols } });
}

// ---------------------------------------------------------------- files (#13)

/** A folder inside a running container, through `ls -lA` (busybox and GNU print the same columns). */
export async function listFiles(id: string, path: string): Promise<{ name: string; dir: boolean; link: boolean; size: number; mode: string; mtime: string }[]> {
  const r = await execRun(id, ['ls', '-lA', '--', path.endsWith('/') ? path : `${path}/`]).catch((e) => {
    throw new Error(/executable file not found|no such file/i.test((e as Error).message) ? 'This container has no ls (a minimal image): its files cannot be listed' : (e as Error).message);
  });
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `ls exited ${r.code}`);
  const out: { name: string; dir: boolean; link: boolean; size: number; mode: string; mtime: string }[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^([dlcbps-][rwxsStT-]{9}\S*)\s+\d+\s+\S+\s+\S+\s+(\d+)(?:,\s*\d+)?\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const link = m[1][0] === 'l';
    const name = link ? m[4].split(' -> ')[0] : m[4];
    out.push({ name, dir: m[1][0] === 'd', link, size: Number(m[2]), mode: m[1], mtime: m[3].replace(/\s+/g, ' ') });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** A file or folder from a container, as Docker's tar archive. */
export async function archive(id: string, path: string): Promise<IncomingMessage> {
  return docker.stream('GET', `/containers/${encodeURIComponent(id)}/archive`, { query: { path } });
}

// ---------------------------------------------------------------- images, volumes, networks

interface ApiImage {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
  Size: number;
  Created: number;
}

export async function listImages(): Promise<DcImage[]> {
  const [imgs, conts] = await Promise.all([docker.get<ApiImage[]>('/images/json', { all: false }), docker.get<ApiContainer[]>('/containers/json', { all: true })]);
  const used = new Map<string, number>();
  for (const c of conts) used.set(c.ImageID, (used.get(c.ImageID) ?? 0) + 1);
  return imgs
    .map((i) => {
      const tags = (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
      return { id: i.Id, tags: tags.length ? tags : (i.RepoDigests ?? []).map((d) => `${d.split('@')[0]}:<none>`).slice(0, 1), size: i.Size, created: i.Created * 1000, containers: used.get(i.Id) ?? 0, dangling: !tags.length };
    })
    .sort((a, b) => (a.tags[0] ?? '~').localeCompare(b.tags[0] ?? '~'));
}

export async function imageRemove(id: string, force: boolean): Promise<void> {
  await docker.json('DELETE', `/images/${encodeURIComponent(id)}`, { query: { force }, timeout: 120_000 });
}

/** Pulls an image; `line` gets Docker's progress as readable lines. */
export async function imagePull(ref: string, line: (text: string) => void, signal: AbortSignal): Promise<void> {
  const at = ref.lastIndexOf(':');
  const hasTag = at > ref.lastIndexOf('/');
  const res = await docker.stream('POST', '/images/create', { query: { fromImage: hasTag ? ref.slice(0, at) : ref, tag: hasTag ? ref.slice(at + 1) : 'latest' } });
  signal.addEventListener('abort', () => res.destroy(), { once: true });
  let buf = '';
  let error = '';
  await new Promise<void>((resolve, reject) => {
    res.on('data', (c: Buffer) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!l) continue;
        try {
          const j = JSON.parse(l) as { status?: string; id?: string; progress?: string; error?: string };
          if (j.error) error = j.error;
          else if (j.status && !j.progress) line(`${j.id ? `${j.id}: ` : ''}${j.status}`);
        } catch {
          /* partial */
        }
      }
    });
    res.on('end', () => (error ? reject(new Error(error)) : resolve()));
    res.on('error', (e) => reject(signal.aborted ? new Error('Cancelled') : e));
  });
}

interface ApiVolume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  CreatedAt: string;
  Labels: Record<string, string> | null;
  UsageData?: { Size: number } | null;
}

export async function listVolumes(): Promise<DcVolume[]> {
  const [{ Volumes }, conts, df] = await Promise.all([
    docker.get<{ Volumes: ApiVolume[] | null }>('/volumes'),
    docker.get<ApiContainer[]>('/containers/json', { all: true }),
    docker.get<{ Volumes?: ApiVolume[] | null }>('/system/df', { type: 'volume' }).catch(() => ({ Volumes: [] as ApiVolume[] })),
  ]);
  const sizes = new Map((df.Volumes ?? []).map((v) => [v.Name, v.UsageData?.Size ?? null]));
  const users = new Map<string, string[]>();
  for (const c of conts) for (const m of c.Mounts ?? []) if (m.Type === 'volume' && m.Name) users.set(m.Name, [...(users.get(m.Name) ?? []), (c.Names[0] ?? '').replace(/^\//, '')]);
  return (Volumes ?? [])
    .map((v) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, created: v.CreatedAt, project: v.Labels?.[PROJECT] ?? null, size: sizes.get(v.Name) ?? null, containers: users.get(v.Name) ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function volumeRemove(name: string): Promise<void> {
  await docker.json('DELETE', `/volumes/${encodeURIComponent(name)}`, { timeout: 60_000 });
}

interface ApiNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  Internal: boolean;
  Labels: Record<string, string> | null;
  IPAM?: { Config?: { Subnet?: string }[] | null };
}

export async function listNetworks(): Promise<DcNetwork[]> {
  const [nets, conts] = await Promise.all([docker.get<ApiNetwork[]>('/networks'), docker.get<ApiContainer[]>('/containers/json', { all: true })]);
  return nets
    .map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
      internal: n.Internal,
      builtin: ['bridge', 'host', 'none'].includes(n.Name),
      project: n.Labels?.[PROJECT] ?? null,
      subnet: n.IPAM?.Config?.map((c) => c.Subnet).filter(Boolean).join(', ') ?? '',
      containers: conts.filter((c) => Object.keys(c.NetworkSettings?.Networks ?? {}).includes(n.Name)).map((c) => (c.Names[0] ?? '').replace(/^\//, '')),
    }))
    .sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
}

export async function networkRemove(id: string): Promise<void> {
  await docker.json('DELETE', `/networks/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------- prune (#14) and disk usage

interface ApiDf {
  LayersSize?: number;
  Images?: (ApiImage & { Containers: number; SharedSize: number })[] | null;
  Containers?: (ApiContainer & { SizeRw?: number })[] | null;
  Volumes?: (ApiVolume & { UsageData?: { Size: number; RefCount: number } | null })[] | null;
  BuildCache?: { ID: string; Description?: string; Size: number; InUse: boolean; Shared: boolean }[] | null;
}

export async function diskUsage(): Promise<DcDiskUsage> {
  const df = await docker.json<ApiDf>('GET', '/system/df', { timeout: 60_000 });
  const imgs = df.Images ?? [];
  const conts = df.Containers ?? [];
  const vols = df.Volumes ?? [];
  const cache = df.BuildCache ?? [];
  return {
    images: { count: imgs.length, size: df.LayersSize ?? imgs.reduce((a, i) => a + i.Size, 0), reclaimable: imgs.filter((i) => i.Containers === 0).reduce((a, i) => a + i.Size - Math.max(0, i.SharedSize), 0) },
    containers: { count: conts.length, size: conts.reduce((a, c) => a + (c.SizeRw ?? 0), 0), reclaimable: conts.filter((c) => c.State !== 'running').reduce((a, c) => a + (c.SizeRw ?? 0), 0) },
    volumes: { count: vols.length, size: vols.reduce((a, v) => a + Math.max(0, v.UsageData?.Size ?? 0), 0), reclaimable: vols.filter((v) => (v.UsageData?.RefCount ?? 1) === 0).reduce((a, v) => a + Math.max(0, v.UsageData?.Size ?? 0), 0) },
    buildCache: { count: cache.length, size: cache.reduce((a, b) => a + b.Size, 0), reclaimable: cache.filter((b) => !b.InUse && !b.Shared).reduce((a, b) => a + b.Size, 0) },
  };
}

/** Exactly what prune would remove, listed before anything goes. */
export async function prunePreview(kind: DcPruneKind): Promise<DcPrunePreview> {
  if (kind === 'containers') {
    const list = await docker.get<(ApiContainer & { SizeRw?: number })[]>('/containers/json', { all: true, size: true });
    const items = list.filter((c) => ['exited', 'created', 'dead'].includes(c.State)).map((c) => ({ id: c.Id, name: (c.Names[0] ?? '').replace(/^\//, ''), size: c.SizeRw ?? null }));
    return { kind, items, total: items.reduce((a, i) => a + (i.size ?? 0), 0) };
  }
  if (kind === 'images') {
    const items = (await listImages()).filter((i) => i.containers === 0).map((i) => ({ id: i.id, name: i.tags[0] ?? i.id.slice(7, 19), size: i.size }));
    return { kind, items, total: items.reduce((a, i) => a + (i.size ?? 0), 0) };
  }
  if (kind === 'volumes') {
    const items = (await listVolumes()).filter((v) => !v.containers.length).map((v) => ({ id: v.name, name: v.name, size: v.size }));
    return { kind, items, total: items.reduce((a, i) => a + (i.size ?? 0), 0) };
  }
  if (kind === 'networks') {
    const items = (await listNetworks()).filter((n) => !n.builtin && !n.containers.length).map((n) => ({ id: n.id, name: n.name, size: null }));
    return { kind, items, total: null };
  }
  const df = await docker.json<ApiDf>('GET', '/system/df', { query: { type: 'build-cache' }, timeout: 60_000 });
  const items = (df.BuildCache ?? []).filter((b) => !b.InUse && !b.Shared).map((b) => ({ id: b.ID, name: b.Description || b.ID.slice(0, 12), size: b.Size }));
  return { kind, items, total: items.reduce((a, i) => a + (i.size ?? 0), 0) };
}

/** Removes what the preview listed (the same filters: unused images, every unused volume, stopped containers). */
export async function prune(kind: DcPruneKind): Promise<{ removed: number; freed: number }> {
  if (kind === 'images') {
    const r = await docker.json<{ ImagesDeleted: unknown[] | null; SpaceReclaimed: number }>('POST', '/images/prune', { query: { filters: JSON.stringify({ dangling: ['false'] }) }, timeout: 600_000 });
    return { removed: r.ImagesDeleted?.length ?? 0, freed: r.SpaceReclaimed ?? 0 };
  }
  if (kind === 'volumes') {
    const r = await docker.json<{ VolumesDeleted: string[] | null; SpaceReclaimed: number }>('POST', '/volumes/prune', { query: { filters: JSON.stringify({ all: ['true'] }) }, timeout: 600_000 });
    return { removed: r.VolumesDeleted?.length ?? 0, freed: r.SpaceReclaimed ?? 0 };
  }
  if (kind === 'containers') {
    const r = await docker.json<{ ContainersDeleted: string[] | null; SpaceReclaimed: number }>('POST', '/containers/prune', { timeout: 600_000 });
    return { removed: r.ContainersDeleted?.length ?? 0, freed: r.SpaceReclaimed ?? 0 };
  }
  if (kind === 'networks') {
    const r = await docker.json<{ NetworksDeleted: string[] | null }>('POST', '/networks/prune', { timeout: 120_000 });
    return { removed: r.NetworksDeleted?.length ?? 0, freed: 0 };
  }
  const r = await docker.json<{ CachesDeleted: string[] | null; SpaceReclaimed: number }>('POST', '/build/prune', { timeout: 600_000 });
  return { removed: r.CachesDeleted?.length ?? 0, freed: r.SpaceReclaimed ?? 0 };
}

// ---------------------------------------------------------------- events

/** Container / image / volume / network events while the engine runs; `onEvent` is called for each. Returns a stop function. */
export async function watchEvents(onEvent: (type: string, action: string) => void, onEnd: () => void): Promise<() => void> {
  const res = await docker.stream('GET', '/events', { query: { filters: JSON.stringify({ type: ['container', 'image', 'volume', 'network'] }) } });
  let buf = '';
  res.on('data', (c: Buffer) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const e = JSON.parse(l) as { Type: string; Action: string };
        onEvent(e.Type, e.Action);
      } catch {
        /* partial */
      }
    }
  });
  res.on('end', onEnd);
  res.on('error', onEnd);
  return () => res.destroy();
}
