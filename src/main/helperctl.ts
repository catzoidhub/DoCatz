import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { EngineConfig, EngineState } from '@shared/types';
import type { EngineLike } from './enginehost';
import { HELPER_PROTOCOL, HelperClient } from './helperproto';
import { isMac, isWin } from './platform';

/**
 * DoCatz's side of the engine helper (#107): starting it (a per-user launchd agent on macOS; a detached process on
 * Windows and Linux until their own login items land), checking its version, stopping it, and RemoteEngine — the
 * Engine's methods answered by the helper over the control channel, so the rest of DoCatz uses one shape either way.
 */

const LABEL = 'tech.catzoid.docatz.engine';
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const helperScript = () => join(app.getAppPath(), 'out', 'helper', 'index.js');
const logFile = () => join(app.getPath('userData'), 'logs', 'helper.log');

/** Which helper build this DoCatz carries: a hash of out/helper/index.js, so a rebuilt DoCatz of the same version replaces it too. */
let build = '';
function helperBuild(): string {
  if (!build) {
    try {
      build = createHash('sha256').update(readFileSync(helperScript())).digest('hex').slice(0, 16);
    } catch {
      build = app.getVersion();
    }
  }
  return build;
}

function helperEnv(): Record<string, string> {
  return {
    DOCATZ_HELPER_BUILD: helperBuild(),
    ELECTRON_RUN_AS_NODE: '1',
    DOCATZ_USERDATA: app.getPath('userData'),
    DOCATZ_VERSION: app.getVersion(),
    DOCATZ_PACKAGED: app.isPackaged ? '1' : '0',
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    ...(process.env.DOCATZ_HOME ? { DOCATZ_HOME: process.env.DOCATZ_HOME } : {}),
    // Lite from a local docatz-engine build until its release (engine/lite.ts).
    ...(process.env.DOCATZ_LITE_LOCAL ? { DOCATZ_LITE_LOCAL: process.env.DOCATZ_LITE_LOCAL } : {}),
  };
}

const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist(): string {
  const env = Object.entries(helperEnv())
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array><string>${xml(process.execPath)}</string><string>${xml(helperScript())}</string></array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${xml(logFile())}</string>
    <key>StandardErrorPath</key><string>${xml(logFile())}</string>
  </dict>
</plist>
`;
}

const launchctl = (...args: string[]) => new Promise<{ code: number; out: string }>((resolve) => execFile('launchctl', args, { timeout: 20_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })));
const domain = () => `gui/${userInfo().uid}`;

/** Starts the helper: the launchd agent (written each time, so a moved or updated DoCatz is the one it runs) or a detached process. */
async function launch(): Promise<void> {
  mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true });
  if (isMac) {
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath(), plist());
    await launchctl('bootout', `${domain()}/${LABEL}`);
    const r = await launchctl('bootstrap', domain(), plistPath());
    if (r.code !== 0) await launchctl('kickstart', '-k', `${domain()}/${LABEL}`);
    return;
  }
  const child = spawn(process.execPath, [helperScript()], { env: { ...process.env, ...helperEnv() }, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** Connects to a running helper of this version, else (re)starts it and waits up to 20 s. */
export async function ensureHelper(client: HelperClient): Promise<void> {
  if (await client.connect()) {
    const v = await client.call<{ version: string; protocol: number; build?: string }>('helper.version').catch(() => null);
    if (v && v.version === app.getVersion() && v.protocol === HELPER_PROTOCOL && v.build === helperBuild()) return;
    // An older (or newer) helper: it goes, the engine itself keeps running on macOS (Lima's VM is not its child).
    await client.call('helper.quit', false).catch(() => undefined);
    client.close();
    await new Promise((r) => setTimeout(r, 800));
  }
  await launch();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await client.connect(1000)) return;
  }
  throw new Error(`The engine helper did not start (see ${logFile()})`);
}

/** Stops the helper for good: no restart by launchd, nothing at login. `stopEngine` also stops the VM / dockerd. */
export async function removeHelper(stopEngine: boolean): Promise<void> {
  const c = new HelperClient();
  if (await c.connect()) {
    await c.call('helper.quit', stopEngine).catch(() => undefined);
    c.close();
  }
  if (isMac) {
    await launchctl('bootout', `${domain()}/${LABEL}`);
    rmSync(plistPath(), { force: true });
  }
}

export const helperInstalled = (): boolean => (isMac ? existsSync(plistPath()) : false);

/** The Engine, answered by the helper. Its state changes arrive as the helper's `engine` events. */
export class RemoteEngine implements EngineLike {
  onChange: (s: EngineState) => void = () => undefined;
  onUp: () => void = () => undefined;
  /** The VM's disk gives freed space back (after a prune): done by the helper, which owns the VM. */
  readonly backend = { trim: () => this.client.call<void>('engine.trim'), sleeping: () => this.client.call<boolean>('engine.sleeping').catch(() => false) };
  private wasUp = false;
  constructor(private client: HelperClient) {}

  /** An `engine` event from the helper. */
  changed(s: EngineState): void {
    this.onChange(s);
    const up = s.status === 'running';
    if (up && !this.wasUp) this.onUp();
    this.wasUp = up;
  }

  private call<T>(m: string, ...a: unknown[]): Promise<T> {
    return this.client.call<T>(`engine.${m}`, ...a);
  }
  up = () => this.call<boolean>('up').catch(() => false);
  state = () => this.call<EngineState>('state');
  start = () => this.call<void>('start');
  stop = () => this.call<void>('stop');
  restart = () => this.call<void>('restart');
  reset = (confirm: string) => this.call<void>('reset', confirm);
  configure = (patch: Partial<EngineConfig>) => this.call<EngineState>('configure', patch);
  cancel = () => void this.call('cancel').catch(() => undefined);
  adopt = () => this.call<void>('adopt');
  setupWsl = () => this.call<void>('setupWsl');
  log = () => this.call<string>('log');
  setContext = (use: boolean) => this.call<EngineState>('setContext', use);
  installCli = () => this.call<void>('installCli');
  setPath = (on: boolean) => this.call<EngineState>('setPath', on);
  dispose = () => this.client.close();
}
