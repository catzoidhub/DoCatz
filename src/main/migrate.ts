import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DcMigrateInventory, DcMigrateSource, DcMigrateSourceId, TaskProgress } from '@shared/types';
import { dockerBin } from './cli';
import { dockerHost } from './paths';
import { isLinux, isWin } from './platform';
import { run } from './proc';

/**
 * Move from another Docker (DoCatz TODO #11): Docker Desktop, OrbStack, Colima or Rancher Desktop on this computer
 * (Podman on Linux, #103).
 * Images go across as they are (`docker save` on the other engine piped into `docker load` on DoCatz's), volumes are
 * made again on DoCatz with the same name and labels (a compose project finds its own) and their files copied with
 * tar through a small container on each side. Nothing is removed from the other engine: both can stay side by side,
 * each with its own docker context. Everything goes through DoCatz's own docker CLI with `-H`, the same on macOS and
 * Windows.
 */

export const HELPER = 'alpine:3.20';
/** On every helper container DoCatz runs on its own engine: the Containers list leaves them out. */
export const HELPER_LABEL = 'com.mrcatz.docatz.helper=1';
const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const programs = process.env.ProgramFiles ?? 'C:\\Program Files';

/** Where each engine listens, and how to tell it is installed when it is not running. */
function known(): { id: DcMigrateSourceId; name: string; hosts: string[]; installed: () => boolean; hint?: string }[] {
  if (isWin)
    return [
      {
        id: 'docker-desktop',
        name: 'Docker Desktop',
        hosts: ['npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine'],
        installed: () => existsSync(join(programs, 'Docker', 'Docker', 'Docker Desktop.exe')),
      },
      { id: 'rancher', name: 'Rancher Desktop', hosts: ['npipe:////./pipe/docker_engine'], installed: () => existsSync(join(local, 'Programs', 'Rancher Desktop', 'Rancher Desktop.exe')) },
    ];
  const home = homedir();
  const colima = (() => {
    try {
      return readdirSync(join(home, '.colima'))
        .filter((p) => !p.startsWith('_'))
        .map((p) => `unix://${join(home, '.colima', p, 'docker.sock')}`);
    } catch {
      return [];
    }
  })();
  // Linux (#101): DoCatz's engine is the system's Docker Engine; the others run their own (Docker Desktop's VM,
  // Rancher Desktop's, Colima's).
  if (isLinux)
    return [
      { id: 'docker-desktop', name: 'Docker Desktop', hosts: [`unix://${join(home, '.docker', 'desktop', 'docker.sock')}`], installed: () => existsSync('/opt/docker-desktop') },
      { id: 'rancher', name: 'Rancher Desktop', hosts: [`unix://${join(home, '.rd', 'docker.sock')}`], installed: () => existsSync('/opt/rancher-desktop') },
      { id: 'colima', name: 'Colima', hosts: colima, installed: () => colima.length > 0 || ['/usr/local/bin/colima', '/usr/bin/colima'].some(existsSync) },
      // #103: Podman answers the Docker API on its socket — the user's own (rootless) first, else the system's
      {
        id: 'podman',
        name: 'Podman',
        hosts: [`unix://${join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'podman', 'podman.sock')}`, 'unix:///run/podman/podman.sock'],
        installed: () => ['/usr/bin/podman', '/usr/local/bin/podman'].some(existsSync),
        hint: 'Turn on its socket: systemctl --user enable --now podman.socket',
      },
    ];
  return [
    { id: 'docker-desktop', name: 'Docker Desktop', hosts: [`unix://${join(home, '.docker', 'run', 'docker.sock')}`], installed: () => existsSync('/Applications/Docker.app') },
    { id: 'orbstack', name: 'OrbStack', hosts: [`unix://${join(home, '.orbstack', 'run', 'docker.sock')}`], installed: () => existsSync('/Applications/OrbStack.app') || existsSync(join(home, 'Applications', 'OrbStack.app')) },
    { id: 'colima', name: 'Colima', hosts: colima, installed: () => colima.length > 0 || ['/opt/homebrew/bin/colima', '/usr/local/bin/colima'].some(existsSync) },
    { id: 'rancher', name: 'Rancher Desktop', hosts: [`unix://${join(home, '.rd', 'docker.sock')}`], installed: () => existsSync('/Applications/Rancher Desktop.app') },
  ];
}

const docker = (host: string, args: string[], timeout = 30_000) => run(dockerBin(), ['-H', host, ...args], { timeout });
const lines = (out: string) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const json = <T>(out: string): T[] =>
  lines(out).flatMap((l) => {
    try {
      return [JSON.parse(l) as T];
    } catch {
      return [];
    }
  });

/** The engine answers there (its server version), or null. */
async function answers(host: string): Promise<string | null> {
  if (host.startsWith('unix://') && !existsSync(host.slice(7))) return null;
  const r = await docker(host, ['version', '--format', '{{.Server.Version}}'], 8_000).catch(() => null);
  return r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The other engines on this computer: running ones with their address, installed ones that are stopped. */
export async function migrateSources(): Promise<DcMigrateSource[]> {
  const out: DcMigrateSource[] = [];
  const mine = dockerHost();
  for (const k of known()) {
    let host: string | null = null;
    let version: string | null = null;
    for (const h of k.hosts) {
      if (h === mine || out.some((o) => o.host === h)) continue;
      version = await answers(h);
      if (version) {
        host = h;
        break;
      }
    }
    if (host || k.installed()) out.push({ id: k.id, name: k.name, host, version, running: !!host, ...(k.hint && !host ? { hint: k.hint } : {}) });
  }
  return out;
}

const sourceHost = async (id: DcMigrateSourceId): Promise<string> => {
  const s = (await migrateSources()).find((x) => x.id === id);
  if (!s?.host) throw new Error(`${s?.name ?? id} is not running: start it, then look again`);
  return s.host;
};

/** Bytes from Docker's human sizes ("1.2GB", "512kB"). */
const bytesOf = (s: string): number => {
  const m = /([\d.]+)\s*([kKMGT]?)i?B/.exec(s);
  if (!m) return 0;
  return Math.round(Number(m[1]) * { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2] as '' | 'k']!);
};

/** What the other engine has: tagged images and volumes, each marked when DoCatz already has it. */
export async function migrateInventory(id: DcMigrateSourceId): Promise<DcMigrateInventory> {
  const host = await sourceHost(id);
  const mine = dockerHost();
  const [imgs, mineImgs, df, mineVols] = await Promise.all([
    docker(host, ['images', '--format', '{{json .}}'], 60_000),
    docker(mine, ['images', '--format', '{{json .}}'], 60_000),
    docker(host, ['system', 'df', '-v', '--format', '{{json .Volumes}}'], 120_000),
    docker(mine, ['volume', 'ls', '--format', '{{.Name}}'], 30_000),
  ]);
  if (imgs.code !== 0) throw new Error(imgs.stderr.trim() || 'Its images could not be listed');
  type Img = { Repository: string; Tag: string; ID: string; Size: string };
  const have = new Set(json<Img>(mineImgs.stdout).map((i) => `${i.Repository}:${i.Tag}`));
  const haveIds = new Set(json<Img>(mineImgs.stdout).map((i) => i.ID));
  const images = json<Img>(imgs.stdout)
    .filter((i) => i.Repository !== '<none>' && i.Tag !== '<none>')
    .map((i) => ({ ref: `${i.Repository}:${i.Tag}`, id: i.ID, size: bytesOf(i.Size), inDocatz: have.has(`${i.Repository}:${i.Tag}`) && haveIds.has(i.ID) }));
  type Vol = { Name: string; Size: string; Links: number };
  let vols: Vol[] = [];
  try {
    vols = (JSON.parse(df.stdout.trim() || '[]') as Vol[]) ?? [];
  } catch {
    vols = [];
  }
  if (!vols.length) {
    // an older engine without `system df --format`: names only
    const r = await docker(host, ['volume', 'ls', '--format', '{{.Name}}']);
    vols = lines(r.stdout).map((Name) => ({ Name, Size: '', Links: 0 }));
  }
  const haveVols = new Set(lines(mineVols.stdout));
  const volumes = vols
    // anonymous volumes (64 hex) belong to one container's life, not worth carrying over
    .filter((v) => !/^[0-9a-f]{64}$/.test(v.Name))
    .map((v) => ({ name: v.Name, size: bytesOf(v.Size), usedBy: Number(v.Links) || 0, inDocatz: haveVols.has(v.Name) }));
  return { images, volumes };
}

/** `a | b`, counting the bytes that pass; rejects with the failing side's last words. */
export function pipe(a: string[], b: string[], onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const from = spawn(dockerBin(), a, { windowsHide: true });
    const to = spawn(dockerBin(), b, { windowsHide: true });
    let errA = '';
    let errB = '';
    let n = 0;
    from.stderr.on('data', (d) => (errA += d));
    to.stderr.on('data', (d) => (errB += d));
    from.stdout.on('data', (d: Buffer) => onBytes((n += d.length)));
    from.stdout.pipe(to.stdin);
    to.stdin.on('error', () => undefined);
    const stop = () => {
      from.kill();
      to.kill();
    };
    signal.addEventListener('abort', stop, { once: true });
    let codeA: number | null = null;
    from.on('close', (c) => (codeA = c ?? 1));
    to.on('close', (codeB) => {
      signal.removeEventListener('abort', stop);
      if (signal.aborted) return reject(new Error('Cancelled'));
      const last = (s: string) => s.trim().split('\n').pop() ?? '';
      if (codeA) return reject(new Error(last(errA) || `the other engine stopped (exit ${codeA})`));
      if (codeB) return reject(new Error(last(errB) || `DoCatz's engine stopped (exit ${codeB})`));
      resolve();
    });
  });
}

const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

/**
 * Moves the picked images and volumes (copies: the other engine keeps them). One step per item; an item that fails
 * is reported in the end and the rest go on. `set` reports progress, `signal` cancels.
 */
export async function migrate(id: DcMigrateSourceId, images: string[], volumes: string[], set: (p: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<string[]> {
  const host = await sourceHost(id);
  const mine = dockerHost();
  const inv = await migrateInventory(id);
  const failed: string[] = [];
  let step = 0;
  for (const ref of images) {
    if (signal.aborted) throw new Error('Cancelled');
    const size = inv.images.find((i) => i.ref === ref)?.size ?? 0;
    set({ step, detail: `${ref}${size ? ` · ${mb(size)}` : ''}`, fraction: 0 });
    try {
      await pipe(['-H', host, 'save', ref], ['-H', mine, 'load'], (n) => set({ detail: `${ref} · ${mb(n)}${size ? ` of ${mb(size)}` : ''}`, fraction: size ? Math.min(n / size, 1) : undefined }), signal);
    } catch (e) {
      if (signal.aborted) throw e;
      failed.push(`${ref}: ${(e as Error).message}`);
    }
    step++;
  }
  // the helper that reads and writes a volume's files, on both engines (pulled once when missing)
  if (volumes.length) {
    for (const h of [host, mine]) {
      const has = await docker(h, ['image', 'inspect', HELPER], 15_000);
      if (has.code !== 0) {
        set({ step, detail: `Getting ${HELPER} for copying files` });
        const p = await docker(h, ['pull', HELPER], 300_000);
        if (p.code !== 0) throw new Error(`${HELPER} could not be pulled: ${p.stderr.trim().split('\n').pop()}`);
      }
    }
  }
  for (const name of volumes) {
    if (signal.aborted) throw new Error('Cancelled');
    const size = inv.volumes.find((v) => v.name === name)?.size ?? 0;
    set({ step, detail: `${name}${size ? ` · ${mb(size)}` : ''}`, fraction: 0 });
    try {
      // the same labels, so `docker compose` sees its own volume (com.docker.compose.project / volume)
      const ins = await docker(host, ['volume', 'inspect', name, '--format', '{{json .Labels}}']);
      const labels = (() => {
        try {
          return (JSON.parse(ins.stdout.trim() || 'null') ?? {}) as Record<string, string>;
        } catch {
          return {};
        }
      })();
      const exists = await docker(mine, ['volume', 'inspect', name], 15_000);
      if (exists.code !== 0) {
        const c = await docker(mine, ['volume', 'create', ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), name]);
        if (c.code !== 0) throw new Error(c.stderr.trim() || 'the volume could not be made');
      }
      await pipe(
        ['-H', host, 'run', '--rm', '-v', `${name}:/from:ro`, HELPER, 'tar', '-C', '/from', '-cf', '-', '.'],
        ['-H', mine, 'run', '--rm', '-i', '--label', HELPER_LABEL, '-v', `${name}:/to`, HELPER, 'tar', '-C', '/to', '-xpf', '-'],
        (n) => set({ detail: `${name} · ${mb(n)}${size ? ` of ${mb(size)}` : ''}`, fraction: size ? Math.min(n / size, 1) : undefined }),
        signal,
      );
    } catch (e) {
      if (signal.aborted) throw e;
      failed.push(`${name}: ${(e as Error).message}`);
    }
    step++;
  }
  set({ step, detail: '', fraction: undefined });
  return failed;
}
