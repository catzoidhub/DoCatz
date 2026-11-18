import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { docatzDir } from './paths';
import { isWin } from './platform';

/**
 * The engine helper's control channel (#107): DoCatz ⇄ the helper process that keeps the engine, the proxy and
 * bridge.json running after the window closes and DoCatz quits. A Unix socket (0600) on macOS / Linux, a named pipe on
 * Windows; never TCP. Every request carries the per-user token from a 0600 file. One JSON object per line:
 *   app → helper   { id, token, method, args }
 *   helper → app   { id, ok: true, result } | { id, ok: false, error }   and events { event, data }
 */
export const HELPER_PROTOCOL = 1;

export const helperSocket = (): string => (isWin ? `\\\\.\\pipe\\docatz_engine_ctl_${userInfo().username.replace(/[^\w.-]/g, '_')}` : join(docatzDir('run'), 'engine.sock'));
const tokenFile = (): string => join(docatzDir('run'), 'engine.token');

/** The token: read, or made once (32 random bytes) by whoever comes first. */
export function helperToken(create = false): string {
  const f = tokenFile();
  try {
    const t = readFileSync(f, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {
    /* none yet */
  }
  if (!create) return '';
  const t = randomBytes(32).toString('hex');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, t, { mode: 0o600 });
  if (!isWin) chmodSync(f, 0o600);
  return t;
}

export type HelperRequest = { id: number; token: string; method: string; args?: unknown[] };
export type HelperReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type HelperEvent = { event: 'engine' | 'domains' | 'list' | 'bye'; data: unknown };

/** Splits a socket's data into JSON lines (at most 4 MB each). */
export function onLines(socket: Socket, fn: (msg: unknown) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > 4 * 1024 * 1024) return socket.destroy();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        fn(JSON.parse(line));
      } catch {
        /* a bad line is dropped */
      }
    }
  });
}

/** The app's side of the channel: calls with replies, and the helper's events. */
export class HelperClient {
  private socket: Socket | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onEvent: (e: HelperEvent) => void = () => undefined;
  onClose: () => void = () => undefined;

  /** Connects (false when no helper answers within `ms`). */
  connect(ms = 1500): Promise<boolean> {
    if (!isWin && !existsSync(helperSocket())) return Promise.resolve(false);
    return new Promise((resolve) => {
      const s = createConnection(helperSocket());
      const timer = setTimeout(() => (s.destroy(), resolve(false)), ms);
      s.once('error', () => (clearTimeout(timer), resolve(false)));
      s.once('connect', () => {
        clearTimeout(timer);
        this.socket = s;
        onLines(s, (m) => this.message(m as HelperReply | HelperEvent));
        s.on('close', () => {
          this.socket = null;
          for (const w of this.waiting.values()) w.reject(new Error('The engine helper went away'));
          this.waiting.clear();
          this.onClose();
        });
        s.on('error', () => undefined);
        resolve(true);
      });
    });
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  private message(m: HelperReply | HelperEvent): void {
    if ('event' in m) return this.onEvent(m);
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.ok) w.resolve(m.result);
    else w.reject(new Error(m.error));
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const s = this.socket;
    if (!s || s.destroyed) return Promise.reject(new Error('The engine helper is not running'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      s.write(`${JSON.stringify({ id, token: helperToken(), method, args } satisfies HelperRequest)}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
