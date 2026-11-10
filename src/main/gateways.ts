import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DcGateway } from '@shared/types';
import { appDataDir } from './platform';

/**
 * DevCatz Services on DoCatz (every platform; Windows only until 2026-11-09): what DevCatz runs on DoCatz's engine, in
 * one read-only group.
 * - Its gateways: Postal, ntfy, Gotify, Jasmin, Telegram Bot API and WAHA, as compose projects `devcatz-gw-<kind>`
 *   (WAHA is the plain container `devcatz-waha`), listed in bridge.json's `gateways`.
 * - Its servers with no Windows build (#62, Windows): Typesense, Sonic and Sockudo, as compose projects `devcatz-svc-<kind>`,
 *   listed in bridge.json's `services` in the same shape.
 * DevCatz lists every entry, installed or not, with no secrets. DoCatz shows the Docker ones. Their lifecycle stays
 * DevCatz's (its `link`, devcatz://gateways/<kind> or devcatz://services/<kind>, `?install=1`, `?action=…`), as DevCatz
 * keeps `compose up` attached to them. DEVCATZ_BRIDGE points elsewhere, for tests.
 */

const FILE = () =>
  process.env.DEVCATZ_BRIDGE ||
  join(appDataDir('DevCatz'), 'bridge.json');

let cache: { mtime: number; list: DcGateway[] } | null = null;

const str = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);

/** The Docker gateways and services DevCatz lists, checked field by field (another app writes the file); [] without it. */
export function devcatzGateways(): DcGateway[] {
  let mtime: number;
  try {
    mtime = statSync(FILE()).mtimeMs;
  } catch {
    return [];
  }
  if (cache?.mtime === mtime) return cache.list;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE(), 'utf8').replace(/^﻿/, ''));
  } catch {
    return cache?.list ?? [];
  }
  const list: DcGateway[] = [];
  const doc = raw as { gateways?: unknown[]; services?: unknown[] };
  const entries = [...(doc?.gateways ?? []).map((g) => [g, 'gateways'] as const), ...(doc?.services ?? []).map((g) => [g, 'services'] as const)] as [Record<string, unknown>, 'gateways' | 'services'][];
  for (const [g, from] of entries) {
    const kind = str(g?.kind, /^[a-z0-9-]{1,30}$/);
    if (!kind || g.docker !== true) continue;
    const project = str(g.project, /^devcatz-(gw|svc)-[a-z0-9-]{1,40}$/);
    const container = str(g.container, /^devcatz-[\w.-]{1,60}$/);
    if (!project && !container) continue;
    list.push({
      kind,
      name: str(g.name, /^[\w .+-]{1,60}$/) ?? kind,
      category: str(g.category, /^[a-z-]{1,30}$/) ?? '',
      installed: g.installed === true,
      status: str(g.status, /^[a-z-]{1,20}$/) ?? '',
      version: str(g.version, /^[\w.+-]{1,40}$/),
      webUi: str(g.webUi, /^https?:\/\/[^\s"<>]{1,300}$/),
      url: str(g.url, /^https?:\/\/[^\s"<>/]{1,200}\/?$/)?.replace(/\/$/, '') ?? null,
      apiPort: (() => {
        const m = str(g.api, /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/)?.match(/:(\d{1,5})\/?$/);
        return m ? Number(m[1]) : null;
      })(),
      project,
      container,
      // DevCatz's own link for it; a missing or odd one falls back to the page it has for that list
      link: str(g.link, /^devcatz:\/\/(gateways|services)\/[a-z0-9-]{1,30}(\?[\w=&-]{0,60})?$/) ?? `devcatz://${from}/${kind}`,
    });
  }
  cache = { mtime, list };
  return list;
}

/**
 * DevCatz's own address for a container it runs here (https://waha.localhost), so DoCatz shows and opens the name DevCatz
 * shows, uses in its .env lines and its tray — not DoCatz's devcatz-waha.docatz.localhost, which reaches the same
 * container (user, 2026-11-10: "tetap tertulis waha.localhost … ini tidak hanya terjadi di waha"). WAHA is matched by
 * its container; a compose project's container by the port DevCatz talks to (`api`, 127.0.0.1:<port>), so its database
 * keeps no address. Null: not DevCatz's, or DevCatz has no address for it.
 */
export function devcatzUrl(c: { name: string; project: string | null; ports: { public: number | null }[] }): string | null {
  for (const g of devcatzGateways()) {
    if (!g.url) continue;
    if (g.container && c.name === g.container) return g.url;
    if (g.project && c.project === g.project && g.apiPort && c.ports.some((p) => p.public === g.apiPort)) return g.url;
  }
  return null;
}
