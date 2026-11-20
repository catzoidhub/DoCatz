import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DcContainer, DcSocketLink } from '@shared/types';
import { serviceDirOf } from './frameworks';

/**
 * Socket services → "Open in DialCatz" as a WebSocket tab (DialCatz's dialcatz://ws link, 2026-11-20): DialCatz speaks
 * raw WebSocket, Socket.IO and Pusher (Soketi, Reverb, Sockudo). Found by the image (Soketi, Sockudo, Centrifugo), by a
 * Laravel service running Reverb, or by `socket.io` in a Node service's package.json. Pusher's app key comes from the
 * container's environment (it is the public half: browsers carry it); the secret goes only as a {{VARIABLE}} name that
 * DialCatz fills from the project's .env it imported — its value never leaves DoCatz.
 */

type Kind = { label: string; mode: DcSocketLink['mode']; port: number; path?: (env: Record<string, string>) => string; secret?: string };

const PUSHER = (keys: string[], fallback: string | null, secret: string, label: string, port: number): Kind => ({
  label,
  mode: 'pusher',
  port,
  secret,
  path: (env) => `/app/${encodeURIComponent(keys.map((k) => env[k]).find(Boolean) ?? fallback ?? 'app-key')}`,
});

/** The image's name without registry and tag: quay.io/soketi/soketi:1.6-16-alpine → soketi/soketi. */
const imageName = (image: string) => image.toLowerCase().replace(/@.*$/, '').replace(/:[^/]*$/, '').replace(/^[^/]+\.[^/]+\//, '');

function kindOf(c: DcContainer, env: Record<string, string>): Kind | null {
  const img = imageName(c.image);
  if (/(^|\/)soketi$/.test(img)) return PUSHER(['SOKETI_DEFAULT_APP_KEY', 'PUSHER_APP_KEY'], 'app-key', 'PUSHER_APP_SECRET', 'Soketi (Pusher)', 6001);
  if (/(^|\/)sockudo$/.test(img)) return PUSHER(['SOCKUDO_DEFAULT_APP_KEY', 'PUSHER_APP_KEY'], 'app-key', 'PUSHER_APP_SECRET', 'Sockudo (Pusher)', 6001);
  if (/(^|\/)centrifugo$/.test(img)) return { label: 'Centrifugo', mode: 'raw', port: 8000, path: () => '/connection/websocket' };
  // Laravel Reverb runs in the app's own image (php artisan reverb:start): a Laravel service named for it, with its key.
  if (c.framework?.framework === 'laravel' && /reverb/i.test(c.service ?? c.name) && env.REVERB_APP_KEY)
    return PUSHER(['REVERB_APP_KEY'], null, 'REVERB_APP_SECRET', 'Laravel Reverb (Pusher)', Number(env.REVERB_SERVER_PORT) || 8080);
  const dir = serviceDirOf(c.project, c.service);
  if (dir && ['node', 'express', 'nestjs'].includes(c.framework?.framework ?? '')) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      if (pkg.dependencies?.['socket.io']) return { label: 'Socket.IO', mode: 'socketio', port: 0 };
    } catch {
      /* no package.json */
    }
  }
  return null;
}

/**
 * The DialCatz link for a socket container, or null. Its address: the socket port published on this computer when it is
 * (ws://127.0.0.1:<port>), else the container's DoCatz name (wss:// when DoCatz serves it over HTTPS).
 */
export function socketLinkOf(c: DcContainer, env: Record<string, string>): DcSocketLink | null {
  if (c.state !== 'running') return null;
  const k = kindOf(c, env);
  if (!k) return null;
  const pub = c.ports.find((p) => p.type === 'tcp' && p.public && (k.port ? p.private === k.port : true))?.public;
  const base = pub && (k.port || !c.url) ? `ws://127.0.0.1:${pub}` : c.url ? c.url.replace(/^http/, 'ws').replace(/\/$/, '') : null;
  if (!base) return null;
  const url = `${base}${k.path ? k.path(env) : ''}`;
  const q = new URLSearchParams({ url, mode: k.mode, name: `${c.project ? `${c.project} / ${c.service}` : c.name} (${k.label})` });
  if (k.secret) q.set('secret', `{{${k.secret}}}`);
  return { mode: k.mode, label: k.label, url, link: `dialcatz://ws?${q.toString()}` };
}
