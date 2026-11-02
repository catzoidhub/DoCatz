import { docker } from './client';
import { execRun } from './ops';

/**
 * Domains for containers that publish no port (DoCatz TODO #9, as OrbStack's <service>.<project>.orb.local): a small
 * nginx container on the VM's host network, which can reach every container's own IP. DoCatz's proxy on this
 * computer hands a name to it (Lima / WSL forward its 127.0.0.1 port here), and it forwards by Host to the container's
 * IP on its network and its port: the first exposed port, else the one it listens on, else 80. Its config is written
 * whenever the containers change (Docker's archive API + `nginx -s reload`), so nothing needs publishing and no compose
 * file or Dockerfile changes.
 */

const NAME = 'docatz-router';
const IMAGE = 'nginx:alpine';
export const ROUTER_PORT = Number(process.env.DOCATZ_ROUTER_PORT) || 8790;

export interface RouterTarget {
  host: string;
  ip: string;
  port: number;
}

/** A one-file tar archive (ustar), for Docker's PUT /containers/{id}/archive. */
function tarOne(name: string, body: string): Buffer {
  const data = Buffer.from(body, 'utf8');
  const h = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => h.write(s, off, len, 'ascii');
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  put(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([h, data, pad, Buffer.alloc(1024, 0)]);
}

function config(targets: RouterTarget[]): string {
  const servers = targets
    .map(
      (t) => `  server {
    listen 127.0.0.1:${ROUTER_PORT};
    server_name ${t.host};
    location / {
      proxy_pass http://${t.ip}:${t.port};
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
      proxy_set_header X-Forwarded-Host $host;
      proxy_read_timeout 1h;
      proxy_buffering off;
    }
  }`,
    )
    .join('\n');
  return `# Written by DoCatz — the routes of *.docatz.<tld> to containers' own IPs; replaced on every change.
worker_processes 1;
events { worker_connections 1024; }
http {
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  client_max_body_size 0;
  access_log off;
  server {
    listen 127.0.0.1:${ROUTER_PORT} default_server;
    return 502;
  }
${servers}
}
`;
}

export class Router {
  private id: string | null = null;
  private last = '';
  private listening = new Map<string, number[]>();
  private busy: Promise<void> | null = null;
  private pending: RouterTarget[] | null = null;

  /**
   * The TCP ports a container listens on (from /proc/net/tcp*, any image with `cat`). An empty answer is not kept, so
   * an app that is still booting is looked at again next time.
   */
  async listeningPorts(containerId: string): Promise<number[]> {
    const hit = this.listening.get(containerId);
    if (hit?.length) return hit;
    let ports: number[] = [];
    try {
      const r = await execRun(containerId, ['cat', '/proc/net/tcp', '/proc/net/tcp6']);
      const set = new Set<number>();
      for (const line of r.stdout.split('\n')) {
        // local address 0.0.0.0 / :: / the container's own — never loopback, which the router cannot reach: 127.0.0.0/8
        // (Docker's own DNS listens on 127.0.0.11 in every container of a compose network), ::1 and ::ffff:127.x
        const m = /^\s*\d+:\s+([0-9A-F]+):([0-9A-F]{4})\s+[0-9A-F]+:[0-9A-F]{4}\s+0A\s/.exec(line);
        if (m && !/^[0-9A-F]{6}7F$|^0{24}01000000$|^0{16}FFFF0000[0-9A-F]{6}7F$/.test(m[1])) set.add(parseInt(m[2], 16));
      }
      ports = [...set].sort((a, b) => a - b);
    } catch {
      ports = [];
    }
    if (ports.length) this.listening.set(containerId, ports);
    return ports;
  }

  forget(containerId: string): void {
    this.listening.delete(containerId);
  }

  private async ensure(): Promise<string> {
    if (this.id) {
      const ok = await docker.get<{ State: { Running: boolean } }>(`/containers/${this.id}/json`).catch(() => null);
      if (ok?.State.Running) return this.id;
      if (ok) {
        await docker.json('POST', `/containers/${this.id}/start`).catch(() => undefined);
        return this.id;
      }
      this.id = null;
    }
    const found = (await docker.get<{ Id: string; State: string }[]>('/containers/json', { all: true, filters: JSON.stringify({ name: [`^/${NAME}$`] }) }))[0];
    if (found) {
      if (found.State !== 'running') await docker.json('POST', `/containers/${found.Id}/start`).catch(() => undefined);
      return (this.id = found.Id);
    }
    const images = await docker.get<unknown[]>('/images/json', { filters: JSON.stringify({ reference: [IMAGE] }) });
    if (!images.length) {
      const res = await docker.stream('POST', '/images/create', { query: { fromImage: 'nginx', tag: 'alpine' } });
      await new Promise<void>((resolve, reject) => {
        res.on('data', () => undefined);
        res.on('end', resolve);
        res.on('error', reject);
      });
    }
    const created = await docker.json<{ Id: string }>('POST', '/containers/create', {
      query: { name: NAME },
      body: { Image: IMAGE, Labels: { 'com.mrcatz.docatz.router': '1' }, HostConfig: { NetworkMode: 'host', RestartPolicy: { Name: 'unless-stopped' } } },
    });
    this.id = created.Id;
    this.last = '';
    await docker.json('POST', `/containers/${created.Id}/start`);
    return created.Id;
  }

  /** Writes the routes (only when they changed) and reloads nginx. Calls that come while one runs collapse into one. */
  async update(targets: RouterTarget[]): Promise<void> {
    this.pending = targets;
    if (this.busy) return this.busy;
    this.busy = (async () => {
      while (this.pending) {
        const next = this.pending;
        this.pending = null;
        const body = config(next);
        const id = await this.ensure();
        if (body === this.last) continue;
        const tar = tarOne('nginx.conf', body);
        const res = await docker.raw('PUT', `/containers/${id}/archive`, { query: { path: '/etc/nginx' }, body: tar, headers: { 'Content-Type': 'application/x-tar' } });
        res.resume();
        if ((res.statusCode ?? 500) >= 400) throw new Error(`The router's config could not be written (${res.statusCode})`);
        const r = await execRun(id, ['nginx', '-s', 'reload']);
        if (r.code !== 0) throw new Error(`The router did not take its routes: ${r.stderr.trim()}`);
        this.last = body;
      }
    })().finally(() => (this.busy = null));
    return this.busy;
  }

  /** The router is DoCatz's own: it never shows in the containers list. */
  static isRouter(name: string): boolean {
    return name === NAME;
  }
}
