import type { Readable, Writable } from 'node:stream';

/**
 * Windows paths in bind mounts, as Docker Desktop's proxy translates them: the docker CLI and compose on Windows send
 * `C:\Users\me\app:/app` (compose makes every relative `./src` one), which a Linux dockerd refuses ("invalid volume
 * specification"). On the engine's pipe, a container create has them pointed at WSL's own mount of the drive —
 * /mnt/c/Users/me/app. Everything else goes through byte for byte: after an upgraded (exec, attach) or chunked request
 * the rest of that connection is passed on as it is.
 */

const WIN = /^([A-Za-z]):(?:[\\/](.*))?$/;
const CREATE = /^(\/v[\d.]+)?\/containers\/create(\?|$)/;
const MAX_BODY = 8 * 1024 * 1024;

/** C:\Users\me\app (or C:/Users/me/app) → /mnt/c/Users/me/app; anything else as it is. */
export function wslPath(p: string): string {
  const m = WIN.exec(p);
  if (!m) return p;
  const rest = (m[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** `C:\src:/app:ro` → `/mnt/c/src:/app:ro` (the drive's colon is not the separator). */
export function wslBind(bind: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(bind)) return bind;
  const i = bind.indexOf(':', 2);
  return i < 0 ? wslPath(bind) : `${wslPath(bind.slice(0, i))}${bind.slice(i)}`;
}

/** A container create's body with its Windows bind sources pointed into WSL; null when nothing changed. */
export function rewriteCreate(body: string): string | null {
  let spec: { HostConfig?: { Binds?: unknown; Mounts?: unknown } };
  try {
    spec = JSON.parse(body);
  } catch {
    return null;
  }
  const hc = spec?.HostConfig;
  if (!hc) return null;
  let changed = false;
  if (Array.isArray(hc.Binds)) {
    hc.Binds = hc.Binds.map((b: unknown) => {
      const r = typeof b === 'string' ? wslBind(b) : b;
      if (r !== b) changed = true;
      return r;
    });
  }
  if (Array.isArray(hc.Mounts)) {
    for (const m of hc.Mounts as { Type?: string; Source?: unknown }[]) {
      if (m?.Type === 'bind' && typeof m.Source === 'string' && WIN.test(m.Source)) {
        m.Source = wslPath(m.Source);
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(spec) : null;
}

/** Copies the client's requests from `from` to `to`, translating the bind mounts of container creates. */
export function relayRequests(from: Readable, to: Writable): void {
  let buf: Buffer = Buffer.alloc(0);
  let raw = false;
  /** Bytes of the current request's body to pass on as they are. */
  let passLeft = 0;
  /** A container create whose body is being collected. */
  let create: { head: string; length: number } | null = null;
  const passRaw = () => {
    raw = true;
    if (buf.length) to.write(buf);
    buf = Buffer.alloc(0);
  };
  from.on('data', (chunk: Buffer) => {
    if (raw) return void to.write(chunk);
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (passLeft > 0) {
        const n = Math.min(passLeft, buf.length);
        if (!n) return;
        to.write(buf.subarray(0, n));
        buf = buf.subarray(n);
        passLeft -= n;
        continue;
      }
      if (create) {
        if (buf.length < create.length) return;
        const body = buf.subarray(0, create.length).toString('utf8');
        buf = buf.subarray(create.length);
        const next = rewriteCreate(body);
        to.write(next === null ? create.head : create.head.replace(/^content-length:.*$/im, `Content-Length: ${Buffer.byteLength(next)}`));
        to.write(next ?? body);
        create = null;
        continue;
      }
      if (!buf.length) return;
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 64 * 1024) passRaw();
        return;
      }
      const head = buf.subarray(0, end + 4).toString('latin1');
      buf = buf.subarray(end + 4);
      const lines = head.split('\r\n');
      const [method, path = ''] = lines[0].split(' ');
      const header = (name: string) => lines.find((l) => l.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim();
      const length = Number(header('content-length') ?? 0);
      if (header('transfer-encoding') || header('upgrade') || !Number.isInteger(length) || length < 0) {
        to.write(head);
        return passRaw();
      }
      if (method === 'POST' && CREATE.test(path) && length > 0 && length <= MAX_BODY) {
        create = { head, length };
        continue;
      }
      to.write(head);
      passLeft = length;
    }
  });
  from.on('end', () => {
    if (buf.length) to.write(buf);
    to.end();
  });
}
