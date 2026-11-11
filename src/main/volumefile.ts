import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { DcVolumeArchive, DcVolumeManifest, TaskProgress } from '@shared/types';
import { dockerBin } from './cli';
import { listVolumes } from './docker/ops';
import { HELPER, HELPER_LABEL } from './migrate';
import { dockerHost } from './paths';
import { run } from './proc';

/**
 * A volume to a file and back (DoCatz TODO #102). The files go through a throwaway container with the volume mounted
 * (the helper #11 Migrate uses), as a plain tar on its stdout (export) or through `docker cp -a -` (import); DoCatz compresses and writes the file itself, so
 * the path is this computer's own on every platform (no host path ever reaches the engine, WSL or Lima alike). Beside
 * the archive a small manifest keeps what makes the volume the same again: its name and labels (a compose project
 * finds its own volume by them). An archive without one — any tar or .tar.gz — imports too.
 */

/** `foo.tar.gz` → `foo.volume.json`. */
export const manifestPath = (file: string) => `${file.replace(/\.(tar\.gz|tgz|tar)$/i, '')}.volume.json`;
/** Docker's rule for a volume's name. */
export const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

const docker = (args: string[], timeout = 30_000) => run(dockerBin(), ['-H', dockerHost(), ...args], { timeout });
const last = (s: string) => s.trim().split('\n').pop() ?? '';
const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

async function helper(set: (p: Partial<TaskProgress>) => void): Promise<void> {
  if ((await docker(['image', 'inspect', HELPER], 15_000)).code === 0) return;
  set({ detail: `Getting ${HELPER} for copying files` });
  const p = await docker(['pull', HELPER], 300_000);
  if (p.code !== 0) throw new Error(`${HELPER} could not be pulled: ${last(p.stderr)}`);
}

/** Counts the bytes that pass. */
const counter = (onBytes: (n: number) => void) => {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      onBytes((n += chunk.length));
      cb(null, chunk);
    },
  });
};

/** Running containers that mount it (a copy of a database still writing can be half way). */
export async function volumeWriters(name: string): Promise<string[]> {
  const r = await docker(['ps', '--filter', `volume=${name}`, '--format', '{{.Names}}']);
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** The volume's files into `file` (.tar.gz) and its manifest beside it. `set` reports progress, `signal` cancels. */
export async function exportVolume(name: string, file: string, version: string, set: (p: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<void> {
  const ins = await docker(['volume', 'inspect', name, '--format', '{{json .}}']);
  if (ins.code !== 0) throw new Error(`No volume ${name}`);
  const v = JSON.parse(ins.stdout.trim()) as { Driver: string; Labels: Record<string, string> | null };
  const size = Math.max(0, (await listVolumes().catch(() => [])).find((x) => x.name === name)?.size ?? 0);
  set({ step: 0 });
  await helper(set);
  set({ step: 1, detail: size ? mb(size) : '', fraction: 0 });
  const part = `${file}.part`;
  const child = spawn(dockerBin(), ['-H', dockerHost(), 'run', '--rm', '--label', HELPER_LABEL, '-v', `${name}:/from:ro`, HELPER, 'tar', '-C', '/from', '-cf', '-', '.'], { windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  const stop = () => child.kill();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await pipeline(
      child.stdout,
      counter((n) => set({ detail: `${mb(n)}${size ? ` of ${mb(size)}` : ''}`, fraction: size ? Math.min(n / size, 1) : undefined })),
      createGzip({ level: 6 }),
      createWriteStream(part),
    );
    const code = await exited;
    if (signal.aborted) throw new Error('Cancelled');
    if (code) throw new Error(last(err) || `the copy stopped (exit ${code})`);
    set({ step: 2, detail: '', fraction: undefined });
    await rename(part, file);
    const manifest: DcVolumeManifest = { kind: 'docatz-volume', version: 1, name, driver: v.Driver, labels: v.Labels ?? {}, size, docatz: version, exported: new Date().toISOString() };
    await writeFile(manifestPath(file), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    child.kill();
    await rm(part, { force: true });
    throw signal.aborted ? new Error('Cancelled') : e;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** What an archive holds before it is imported: its manifest when there is one, the name to suggest. */
export async function readArchive(file: string): Promise<DcVolumeArchive> {
  const st = await stat(file);
  let manifest: DcVolumeManifest | null = null;
  const m = manifestPath(file);
  if (existsSync(m)) {
    try {
      const j = JSON.parse(await readFile(m, 'utf8')) as DcVolumeManifest;
      if (j?.kind === 'docatz-volume' && typeof j.name === 'string') manifest = j;
    } catch {
      manifest = null;
    }
  }
  const fromFile = basename(file).replace(/\.(tar\.gz|tgz|tar)$/i, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '');
  const name = manifest && VOLUME_NAME.test(manifest.name) ? manifest.name : VOLUME_NAME.test(fromFile) ? fromFile : 'imported-volume';
  const vols = await listVolumes();
  return { file, fileName: basename(file), size: st.size, manifest, name, taken: vols.map((v) => v.name) };
}

/**
 * The archive's files into a new volume `name`, or — `replace` — into an existing one, whose files go first. A new
 * volume keeps the manifest's labels when it keeps its name (so its compose project finds it); one that fails half
 * way is removed again.
 */
export async function importVolume(file: string, name: string, replace: boolean, set: (p: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<void> {
  if (!VOLUME_NAME.test(name)) throw new Error('A volume name has letters, digits, _ . - and starts with a letter or digit');
  const a = await readArchive(file);
  const exists = a.taken.includes(name);
  if (exists && !replace) throw new Error(`A volume named ${name} exists: pick another name, or replace its contents`);
  if (!exists && replace) throw new Error(`No volume ${name} to replace`);
  if (exists) {
    const writers = await volumeWriters(name);
    if (writers.length) throw new Error(`${name} is in use by ${writers.join(', ')}: stop ${writers.length === 1 ? 'it' : 'them'} first`);
  }
  set({ step: 0 });
  await helper(set);
  let made = false;
  if (!exists) {
    const labels = a.manifest && a.manifest.name === name ? a.manifest.labels : {};
    const c = await docker(['volume', 'create', ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), name]);
    if (c.code !== 0) throw new Error(last(c.stderr) || 'the volume could not be made');
    made = true;
  }
  // gzip or a plain tar: the first two bytes tell
  const head = Buffer.alloc(2);
  const fh = await open(file, 'r');
  await fh.read(head, 0, 2, 0).finally(() => fh.close());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  set({ step: 1, detail: mb(a.size), fraction: 0 });
  // The files go in with `docker cp -a -` into a helper that is only created (never started) with the volume mounted:
  // an HTTP upload with its own end. `docker run -i … tar -x` needed the CLI to half-close the connection when its stdin
  // ended, which the WSL engine's named pipe cannot carry — on Windows tar waited for more forever at 100 % (found on the
  // Windows PC, 2026-11-11). `-a` keeps the files' owners, as tar -p did.
  let box = '';
  let child: ReturnType<typeof spawn> | null = null;
  let exited: Promise<number> = Promise.resolve(0);
  const stop = () => child?.kill();
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (replace) {
      const w = await docker(['run', '--rm', '--label', HELPER_LABEL, '-v', `${name}:/to`, HELPER, 'find', '/to', '-mindepth', '1', '-delete'], 600_000);
      if (w.code !== 0) throw new Error(last(w.stderr) || `${name}’s old files could not be removed`);
    }
    if (signal.aborted) throw new Error('Cancelled');
    const c = await docker(['create', '--label', HELPER_LABEL, '-v', `${name}:/to`, HELPER, 'true']);
    if (c.code !== 0) throw new Error(last(c.stderr) || 'the copy could not start');
    box = last(c.stdout);
    const cp = spawn(dockerBin(), ['-H', dockerHost(), 'cp', '-a', '-', `${box}:/to`], { windowsHide: true });
    child = cp;
    let err = '';
    cp.stderr.on('data', (d) => (err += d));
    cp.stdin.on('error', () => undefined);
    exited = new Promise<number>((resolve) => cp.on('close', (code) => resolve(code ?? 1)));
    const progress = counter((n) => set({ detail: `${mb(n)} of ${mb(a.size)}`, fraction: Math.min(n / Math.max(1, a.size), 1) }));
    await (gz ? pipeline(createReadStream(file), progress, createGunzip(), cp.stdin) : pipeline(createReadStream(file), progress, cp.stdin));
    const code = await exited;
    if (signal.aborted) throw new Error('Cancelled');
    if (code) throw new Error(last(err) || `the copy stopped (exit ${code})`);
    set({ step: 2, detail: '', fraction: undefined });
  } catch (e) {
    child?.kill();
    await exited.catch(() => 1);
    if (box) await docker(['rm', '-f', box]).catch(() => null);
    box = '';
    if (made) await docker(['volume', 'rm', name]).catch(() => null);
    const m = signal.aborted ? 'Cancelled' : (e as Error).message;
    throw new Error(replace && !made && m !== 'Cancelled' ? `${m} (${name}’s old files were already removed)` : replace && m === 'Cancelled' ? `Cancelled: ${name} holds only part of the archive` : m);
  } finally {
    signal.removeEventListener('abort', stop);
    if (box) await docker(['rm', '-f', box]).catch(() => null);
  }
}
