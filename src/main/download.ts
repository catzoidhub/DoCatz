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
  let hash = createHash('sha256');
  let received = 0;
  let total = 0;
  // A dropped connection resumes where it stopped (Range), up to 6 times: on Linux the system's Docker adds and removes
  // network interfaces as containers start and stop, and Chromium ends a download on every change (ERR_NETWORK_CHANGED).
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await net.fetch(p.url, { signal, headers: received ? { Range: `bytes=${received}-` } : undefined });
    } catch (e) {
      if (signal?.aborted) throw new Cancelled();
      if (attempt < 6 && transient(e)) {
        await pause(1000, signal);
        continue;
      }
      throw new Error(`Could not reach ${new URL(p.url).host}: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) throw new Error(`${new URL(p.url).host} answered ${res.status} for ${p.name}`);
    if (received && res.status !== 206) {
      // The server sent the whole file again: start over.
      hash = createHash('sha256');
      received = 0;
      rmSync(part, { force: true });
    }
    if (!total) total = (Number(res.headers.get('content-length')) || 0) + received;
    const out = createWriteStream(part, { flags: received ? 'a' : 'w' });
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (signal?.aborted) throw new Cancelled();
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        onProgress(total ? received / total : 0, received, total);
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
      break;
    } catch (e) {
      await new Promise<void>((r) => out.end(() => r()));
      if (signal?.aborted) {
        rmSync(part, { force: true });
        throw new Cancelled();
      }
      if (attempt < 6 && transient(e)) {
        await pause(1000, signal);
        continue;
      }
      rmSync(part, { force: true });
      throw e;
    }
  }
  const got = hash.digest('hex');
  if (got !== p.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${p.name} did not match its checksum — the download was damaged or changed, nothing was installed`);
  }
  renameSync(part, file);
  return file;
}

/** A network hiccup worth retrying (Chromium's net errors), not a refusal or a damaged file. */
const transient = (e: unknown) => /ERR_(NETWORK_CHANGED|CONNECTION_(RESET|CLOSED|ABORTED)|INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED|HTTP2_PROTOCOL_ERROR|TIMED_OUT)|ECONNRESET|socket hang up/i.test(String((e as Error)?.message ?? e));

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Cancelled())), { once: true });
  });
}

export async function sha256(file: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
