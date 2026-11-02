import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { net } from 'electron';
import { docatzDir } from './paths';

/**
 * Downloads with a pinned SHA-256 (DoCatz TODO #2 / #7): every file DoCatz fetches for the engine is named in
 * components.ts with its checksum; a file that does not match is deleted and never used. Finished files stay in
 * ~/.docatz/downloads, so a reset or reinstall does not fetch them again.
 */

export interface Pinned {
  url: string;
  sha256: string;
  /** The name it is kept under. */
  name: string;
}

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** The file on disk (downloaded now or before), checked. `onProgress` gets 0–1. */
export async function fetchPinned(p: Pinned, onProgress: (fraction: number, received: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  const file = join(docatzDir('downloads'), p.name);
  if (existsSync(file) && (await sha256(file)) === p.sha256) return file;
  const part = `${file}.part`;
  rmSync(part, { force: true });
  let res: Response;
  try {
    res = await net.fetch(p.url, { signal });
  } catch (e) {
    if (signal?.aborted) throw new Cancelled();
    throw new Error(`Could not reach ${new URL(p.url).host}: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new Error(`${new URL(p.url).host} answered ${res.status} for ${p.name}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw new Cancelled();
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress(total ? received / total : 0, received, total);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    if (signal?.aborted) throw new Cancelled();
    throw e;
  }
  const got = hash.digest('hex');
  if (got !== p.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${p.name} did not match its checksum — the download was damaged or changed, nothing was installed`);
  }
  renameSync(part, file);
  return file;
}

export async function sha256(file: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
