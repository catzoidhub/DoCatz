import { request, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { socketPath } from '../paths';

/**
 * The Docker Engine API over the engine's socket (a Unix socket on macOS, a named pipe on Windows — Node's http
 * speaks to both through `socketPath`). No docker CLI needed for anything the app shows. The API version is the
 * engine's own (GET /version, unversioned), so DoCatz works with older and newer engines.
 */

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class DockerClient {
  private prefix = '';

  private qs(q?: Query): string {
    if (!q) return '';
    const p = Object.entries(q).filter(([, v]) => v !== undefined);
    return p.length ? `?${p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : '';
  }

  private raw(method: string, path: string, o: { query?: Query; body?: unknown; timeout?: number; headers?: Record<string, string> } = {}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const body = o.body === undefined ? undefined : JSON.stringify(o.body);
      const req = request(
        {
          socketPath: socketPath(),
          method,
          path: `${this.prefix}${path}${this.qs(o.query)}`,
          headers: { Host: 'docker', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(o.headers ?? {}) },
          timeout: o.timeout ?? 30_000,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error('The engine did not answer in time')));
      req.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new DockerError('The engine is not running', 0) : e));
      if (body) req.write(body);
      req.end();
    });
  }

  private async text(res: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async fail(res: IncomingMessage): Promise<never> {
    const t = await this.text(res);
    let msg = t.trim();
    try {
      msg = (JSON.parse(t) as { message?: string }).message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new DockerError(msg || `The engine answered ${res.statusCode}`, res.statusCode ?? 0);
  }

  /** Asks the engine for its API version once it answers. */
  async connect(): Promise<{ Version: string; ApiVersion: string; Os: string; Arch: string; KernelVersion: string }> {
    this.prefix = '';
    const res = await this.raw('GET', '/version', { timeout: 5000 });
    if (res.statusCode !== 200) await this.fail(res);
    const v = JSON.parse(await this.text(res));
    this.prefix = `/v${v.ApiVersion}`;
    return v;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.raw('GET', '/_ping', { timeout: 3000 });
      res.resume();
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  async json<T>(method: string, path: string, o: { query?: Query; body?: unknown; timeout?: number } = {}): Promise<T> {
    if (!this.prefix) await this.connect();
    const res = await this.raw(method, path, o);
    if ((res.statusCode ?? 500) >= 400) await this.fail(res);
    const t = await this.text(res);
    return (t ? JSON.parse(t) : null) as T;
  }

  get = <T>(path: string, query?: Query) => this.json<T>('GET', path, { query });

  /** A request whose answer is read as it comes (logs, events, pulls, stats). */
  async stream(method: string, path: string, o: { query?: Query; body?: unknown } = {}): Promise<IncomingMessage> {
    if (!this.prefix) await this.connect();
    const res = await this.raw(method, path, { ...o, timeout: 0 });
    if ((res.statusCode ?? 500) >= 400) await this.fail(res);
    return res;
  }

  /** A request upgraded to a raw two-way connection (exec with a terminal). */
  async hijack(path: string, body: unknown): Promise<Duplex> {
    if (!this.prefix) await this.connect();
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request({
        socketPath: socketPath(),
        method: 'POST',
        path: `${this.prefix}${path}`,
        headers: { Host: 'docker', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      req.on('upgrade', (_res, socket, head) => {
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => void this.fail(res).catch(reject));
      req.on('error', reject);
      req.end(data);
    });
  }
}

/**
 * Splits Docker's multiplexed stream (containers without a terminal): frames of [stream, 0, 0, 0, size BE32] + data.
 * Feed it chunks; it calls `out` with whole frames.
 */
export function demuxer(out: (stream: 'stdout' | 'stderr', data: Buffer) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      out(buf[0] === 2 ? 'stderr' : 'stdout', buf.subarray(8, 8 + size));
      buf = buf.subarray(8 + size);
    }
  };
}

export const docker = new DockerClient();
