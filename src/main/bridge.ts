import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeEntry } from '@catzoid/mcatzp-host';
import type { DcContainer } from '@shared/types';

/**
 * DoCatz's bridge.json (Catzoid ecosystem, DoCatz TODO #22): the containers DoCatz runs, so DevCatz, DBCatz and
 * DialCatz can list them and link back with docatz://container/<name>. Names, compose project / service, image,
 * state, published ports and domains, the compose folder and the framework a service is built from (DialCatz makes an
 * environment of a project's HTTP services and reads their routes, #25) — never environment values, mounts, labels or
 * secrets. Written in DoCatz's
 * data folder (folder 0700, file 0600, atomically) when the list changes; Uninstall removes it with the folder.
 */

export const bridgeFile = () => process.env.DOCATZ_BRIDGE_FILE || join(app.getPath('userData'), 'bridge.json');

let last = '';
let lastContainers: DcContainer[] = [];
let lastEngine: 'running' | 'stopped' = 'stopped';
let lastProxy = { httpsPort: 0, httpPort: 0 };
let mcatzp: BridgeEntry | null = null;

/** The MCatzP entry (protocol version, on / off, channel), so MCatzP finds DoCatz; written at once, whatever else changed. */
export function setBridgeMcatzp(entry: BridgeEntry): void {
  mcatzp = entry;
  writeBridge(lastContainers, lastEngine, lastProxy);
}

/** `proxy`: DoCatz's proxy ports, so DevCatz's proxy can hand *.docatz.<tld> on when :443 points at it (#61). */
export function writeBridge(containers: DcContainer[], engine: 'running' | 'stopped', proxy: { httpsPort: number; httpPort: number }): void {
  lastContainers = containers;
  lastEngine = engine;
  lastProxy = proxy;
  const list = containers.map((c) => ({
    id: c.id.slice(0, 12),
    name: c.name,
    project: c.project,
    service: c.service,
    image: c.image,
    state: c.state,
    ports: c.ports.filter((p) => p.public).map((p) => ({ host: p.public, container: p.private, protocol: p.type })),
    url: c.url,
    /** A database / cache / mail server's address inside its project (postgres:5432): no page, no environment. */
    inner: c.inner ?? null,
    /** The compose file's folder and the framework the service is built from (null for a plain image). */
    dir: c.workingDir,
    framework: c.framework?.framework ?? null,
    library: c.framework?.library ?? null,
  }));
  const body = JSON.stringify({ engine, list, proxy, mcatzp });
  if (body === last) return;
  try {
    const file = bridgeFile();
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    else chmodSync(dir, 0o700);
    const doc = { schema: 1, app: 'DoCatz', version: app.getVersion(), updatedAt: Date.now(), engine, proxy, containers: list, ...(mcatzp ? { mcatzp } : {}) };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    last = body;
  } catch (e) {
    console.warn('bridge.json could not be written:', (e as Error).message);
  }
}
