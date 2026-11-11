import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { DcImageArchive, TaskProgress } from '@shared/types';
import { dockerBin } from './cli';
import { listImages } from './docker/ops';
import { dockerHost } from './paths';

/**
 * Images to a file and back (DoCatz TODO #104): `docker save` of one or more images, gzipped by DoCatz into the file
 * the user picks, and `docker load` of such a file (or any `docker save` tar, plain or gzipped) — for an image built
 * here that no registry has, a computer without internet, or a version kept before an update. The file is this
 * computer's own on every platform: only the bytes go through the docker CLI.
 */

const last = (s: string) => s.trim().split('\n').pop() ?? '';
const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const counter = (onBytes: (n: number) => void) => {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      onBytes((n += chunk.length));
      cb(null, chunk);
    },
  });
};

/** The picked images (tags or ids) into `file` (.tar.gz). Their sizes give the progress (the tar is about as big). */
export async function exportImages(refs: string[], file: string, set: (p: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<void> {
  if (!refs.length) throw new Error('Pick at least one image');
  const all = await listImages();
  const size = refs.reduce((n, r) => n + (all.find((i) => i.tags.includes(r) || i.id === r)?.size ?? 0), 0);
  for (const r of refs) if (!all.some((i) => i.tags.includes(r) || i.id === r)) throw new Error(`No image ${r}`);
  set({ step: 0, detail: size ? `0 MB of ${mb(size)}` : '', fraction: 0 });
  const part = `${file}.part`;
  const child = spawn(dockerBin(), ['-H', dockerHost(), 'save', ...refs], { windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  const stop = () => child.kill();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await pipeline(
      child.stdout,
      counter((n) => set({ detail: `${mb(n)}${size ? ` of ${mb(size)}` : ''}`, fraction: size ? Math.min(n / size, 0.99) : undefined })),
      createGzip({ level: 6 }),
      createWriteStream(part),
    );
    const code = await exited;
    if (signal.aborted) throw new Error('Cancelled');
    if (code) throw new Error(last(err) || `docker save stopped (exit ${code})`);
    await rename(part, file);
    set({ step: 1, detail: '', fraction: undefined });
  } catch (e) {
    child.kill();
    await rm(part, { force: true });
    throw signal.aborted ? new Error('Cancelled') : e;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export async function readImageArchive(file: string): Promise<DcImageArchive> {
  const st = await stat(file);
  return { file, fileName: basename(file), size: st.size };
}

/** `docker load` of an archive; the images it brought (tags, or ids for untagged ones). */
export async function importImages(file: string, set: (p: Partial<TaskProgress>) => void, signal: AbortSignal): Promise<string[]> {
  const { size } = await stat(file);
  const head = Buffer.alloc(2);
  const fh = await open(file, 'r');
  await fh.read(head, 0, 2, 0).finally(() => fh.close());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  set({ step: 0, detail: `0 MB of ${mb(size)}`, fraction: 0 });
  const child = spawn(dockerBin(), ['-H', dockerHost(), 'load'], { windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.stdin.on('error', () => undefined);
  const exited = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  const stop = () => child.kill();
  signal.addEventListener('abort', stop, { once: true });
  try {
    const progress = counter((n) => set({ detail: `${mb(n)} of ${mb(size)}`, fraction: Math.min(n / Math.max(1, size), 0.99) }));
    await (gz ? pipeline(createReadStream(file), progress, createGunzip(), child.stdin) : pipeline(createReadStream(file), progress, child.stdin));
    const code = await exited;
    if (signal.aborted) throw new Error('Cancelled');
    if (code) throw new Error(last(err) || last(out) || `docker load stopped (exit ${code})`);
    set({ step: 1, detail: '', fraction: undefined });
    return [...out.matchAll(/Loaded image(?: ID)?: (\S+)/g)].map((m) => m[1]);
  } catch (e) {
    child.kill();
    throw signal.aborted ? new Error('Cancelled') : e;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
