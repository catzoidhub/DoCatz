import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DcMock } from '@shared/types';
import { appDataDir } from './platform';

/**
 * DialCatz's mock servers for DoCatz's projects (DialCatz ↔ DoCatz mock integration, 2026-11-20): DialCatz runs a mock of
 * a project's API on 127.0.0.1:<port> and lists it in its bridge.json `mocks[]`, with `docatz: { project, service,
 * specFile? }` when it was made from a DoCatz project. DoCatz gives each such mock a name like a service of that project —
 * `dialcatz-mock.<project>.docatz.<tld>`, or `dialcatz-mock-<service>.<project>…` when the project has more than one —
 * through its proxy (HTTP and HTTPS), lists them back in its own bridge.json `dialcatzMocks`, and shows them on the API
 * container's page. The mock's lifecycle stays DialCatz's (dialcatz://mock, dialcatz://open?…&mock=1). DIALCATZ_BRIDGE
 * points elsewhere, for tests.
 */

const FILE = () => process.env.DIALCATZ_BRIDGE || join(appDataDir('DialCatz'), 'bridge.json');
export const dialcatzBridgeFile = FILE;

type Raw = Omit<DcMock, 'domain' | 'url'>;
let cache: { mtime: number; list: Raw[] } | null = null;

const str = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);
const label = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'x';
const ID = /^[\w-]{1,64}$/;

/** DialCatz's running mocks made from a DoCatz project, checked field by field (another app writes the file). */
function read(): Raw[] {
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
  const list: Raw[] = [];
  for (const m of ((raw as { mocks?: unknown[] })?.mocks ?? []) as Record<string, unknown>[]) {
    const d = (m?.docatz ?? null) as Record<string, unknown> | null;
    const project = str(d?.project, /^[\w.-]{1,100}$/);
    const service = str(d?.service, /^[\w.-]{1,100}$/);
    const workspaceId = str(m?.workspaceId, ID);
    const collectionId = str(m?.collectionId, ID);
    const port = typeof m?.port === 'number' && Number.isInteger(m.port) && m.port > 0 && m.port < 65536 ? m.port : null;
    // Only a mock on this computer's loopback: its address is what the proxy forwards to.
    const local = str(m?.url, /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/);
    if (!project || !service || !workspaceId || !collectionId || !port || !local || !local.includes(`:${port}`)) continue;
    list.push({
      name: str(m.name, /^[^\u0000-\u001f]{1,120}$/) ?? service,
      workspaceId,
      collectionId,
      project,
      service,
      specFile: str(d?.specFile, /^[^\u0000-\u001f\\]{1,300}$/),
      port,
      localUrl: `http://127.0.0.1:${port}`,
      startedAt: typeof m.startedAt === 'number' ? m.startedAt : typeof m.startedAt === 'string' ? Date.parse(m.startedAt) || null : null,
    });
  }
  cache = { mtime, list };
  return list;
}

/** The name before `.docatz.<tld>`: one mock in a project → dialcatz-mock.<project>; more → dialcatz-mock-<service>.<project>. */
function hostLabel(m: Raw, all: Raw[]): string {
  const many = all.filter((x) => x.project === m.project).length > 1;
  return `${many ? `dialcatz-mock-${label(m.service)}` : 'dialcatz-mock'}.${label(m.project)}`.slice(0, 200);
}

/** For the proxy (EngineHost → Domains.setRoutes): each mock's name and the 127.0.0.1 port it goes to. */
export function mockRoutes(): { name: string; port: number }[] {
  const all = read();
  return all.map((m) => ({ name: hostLabel(m, all), port: m.port }));
}

/** The mocks with their DoCatz address, as the naming says (TLD, HTTPS, clean URLs). */
export function dialcatzMocks(n: { tld: string; https: boolean; clean: boolean; httpsPort: number; httpPort: number }): DcMock[] {
  const all = read();
  return all.map((m) => {
    const domain = `${hostLabel(m, all)}.docatz.${n.tld}`;
    return { ...m, domain, url: `${n.https ? 'https' : 'http'}://${domain}${n.clean ? '' : `:${n.https ? n.httpsPort : n.httpPort}`}` };
  });
}
