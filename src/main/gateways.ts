import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DcGateway } from '@shared/types';
import { isWin } from './platform';

/**
 * DevCatz's gateways on DoCatz (Windows only; the DevCatz side is its Docker gateways page): DevCatz runs Postal, ntfy,
 * Gotify, Jasmin, Telegram Bot API and WAHA on DoCatz's engine — compose projects `devcatz-gw-<kind>`, WAHA the plain
 * container `devcatz-waha` — and lists every gateway, installed or not, in its bridge.json (no secrets). DoCatz shows
 * the Docker ones in their own group; their lifecycle stays DevCatz's (devcatz://gateways/<kind>?action=…), as DevCatz
 * keeps `compose up` attached to them. DEVCATZ_BRIDGE points elsewhere, for tests.
 */

const FILE = () => process.env.DEVCATZ_BRIDGE || join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DevCatz', 'bridge.json');

let cache: { mtime: number; list: DcGateway[] } | null = null;

const str = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);

/** The Docker gateways DevCatz lists, checked field by field (another app writes the file); [] without it. */
export function devcatzGateways(): DcGateway[] {
  if (!isWin) return [];
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
  for (const g of ((raw as { gateways?: unknown[] })?.gateways ?? []) as Record<string, unknown>[]) {
    const kind = str(g?.kind, /^[a-z0-9-]{1,30}$/);
    if (!kind || g.docker !== true) continue;
    const project = str(g.project, /^devcatz-gw-[a-z0-9-]{1,40}$/);
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
      project,
      container,
    });
  }
  cache = { mtime, list };
  return list;
}
