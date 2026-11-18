import { spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineConfig } from '@shared/types';
import { litePackages, LITE } from '../components';
import { fetchPinned } from '../download';
import { docatzDir, socketPath } from '../paths';
import { lastLine, run } from '../proc';
import { machineArch } from '../machine';
import type { Backend, BackendStatus, StepReporter } from './backend';
import { MountEvents } from './mountevents';

/**
 * macOS Lite (DoCatz TODO #106, beta): our own VM helper `docatz-vmm` on Apple's Virtualization.framework with an
 * Alpine guest, instead of Lima + Ubuntu (catzoidhub/docatz-engine, docs/CONTRACT.md, protocol 1). The VM runs as a
 * process of its own (detached, like Lima's host agent), so it outlives whichever DoCatz process started it — the app
 * or the engine helper (#107); DoCatz asks it over its control socket. The Docker socket appears at the same path as
 * Standard's (~/.docatz/run/docker.sock), so the `docatz` context and every CLI stay the same.
 *
 * Until docatz-engine has a release, DOCATZ_LITE_LOCAL=<docatz-engine>/out takes its local build instead of the pinned
 * download (docatz-vmm-<arch> and guest-<arch>/).
 */

const PROTOCOL = 1;
const dir = (...p: string[]) => docatzDir('lite', ...p);
const vmm = () => join(dir('bin'), 'docatz-vmm');
const guestDir = () => dir('guest', LITE.version);
const vmDir = () => dir('vm');
const dataDisk = () => join(vmDir(), 'data.img');
const ctlSocket = () => join(vmDir(), 'vmm.sock');
const consoleLog = () => join(vmDir(), 'console.log');
const runLog = () => join(vmDir(), 'run.log');
const configFile = () => join(vmDir(), 'config.json');
const archName = () => (machineArch() === 'arm64' ? 'arm64' : 'x86_64');

/** One request on docatz-vmm's control socket (§5); null when nothing answers. */
function control<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T | null> {
  if (!existsSync(ctlSocket())) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const s = createConnection(ctlSocket());
    let buf = '';
    const done = (fn: () => void) => {
      clearTimeout(timer);
      s.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => resolve(null)), timeoutMs);
    s.on('error', () => done(() => resolve(null)));
    s.on('connect', () => s.write(`${JSON.stringify({ id: 1, method, ...(params === undefined ? {} : { params }) })}\n`));
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        try {
          const m = JSON.parse(line) as { id?: number; result?: T; error?: string };
          if (m.id !== 1) continue;
          if (m.error) return done(() => reject(new Error(m.error)));
          return done(() => resolve((m.result ?? null) as T));
        } catch {
          /* not a reply */
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
  });
}

type VmmStatus = { state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'; version?: string; guest?: { docker?: boolean; bootMs?: number } };
type Saved = { cpus: number; memoryMiB: number; diskGiB: number; rosetta: boolean };

export class LiteBackend implements Backend {
  readonly id = 'lite' as const;
  readonly steps = ['Download the Lite engine', 'Prepare the data disk', 'Start the VM and Docker', 'Connect to Docker'];

  private async installed(): Promise<boolean> {
    // A local build (DOCATZ_LITE_LOCAL) keeps one version number while it changes: a newer one is taken again.
    const local = process.env.DOCATZ_LITE_LOCAL;
    if (local && existsSync(vmm())) {
      const newer = (a: string, b: string) => existsSync(a) && existsSync(b) && statSync(a).mtimeMs > statSync(b).mtimeMs;
      if (newer(join(local, `docatz-vmm-${archName()}`), vmm()) || newer(join(local, `guest-${archName()}`, 'rootfs.img'), join(guestDir(), 'rootfs.img'))) return false;
    }
    if (!existsSync(vmm()) || !['vmlinux', 'initramfs.img', 'rootfs.img', 'guest.json'].every((f) => existsSync(join(guestDir(), f)))) return false;
    const r = await run(vmm(), ['version'], { timeout: 15_000 });
    try {
      const v = JSON.parse(r.stdout) as { version: string; protocol: number };
      return v.protocol === PROTOCOL && v.version === LITE.version;
    } catch {
      return false;
    }
  }

  private async install(r: StepReporter): Promise<void> {
    mkdirSync(dir('bin'), { recursive: true });
    // Never write a new docatz-vmm over the old file: macOS keeps the old code signature for that path and kills every
    // new process from it (exit 137). It goes first, then the new one is put there (docatz-engine, 2026-11-18).
    rmSync(vmm(), { force: true });
    rmSync(guestDir(), { recursive: true, force: true });
    mkdirSync(guestDir(), { recursive: true });
    const local = process.env.DOCATZ_LITE_LOCAL;
    if (local) {
      // A local docatz-engine build (no release yet): out/docatz-vmm-<arch> and out/guest-<arch>/.
      const bin = join(local, `docatz-vmm-${archName()}`);
      const guest = join(local, `guest-${archName()}`);
      if (!existsSync(bin) || !existsSync(guest)) throw new Error(`No local Lite build in ${local} (docatz-vmm-${archName()}, guest-${archName()}/)`);
      cpSync(bin, vmm());
      cpSync(guest, guestDir(), { recursive: true });
    } else {
      const pk = litePackages();
      if (!pk) throw new Error('The Lite engine is not released yet — switch back to Standard in Engine');
      for (const [i, p] of [pk.vmm, pk.guest].entries()) {
        const file = await fetchPinned(p, (f, got, total) => r.detail(`Downloading the Lite engine (${i + 1} of 2): ${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`, f), r.signal);
        const x = await run('/usr/bin/tar', ['-xzf', file, '-C', i === 0 ? dir('bin') : guestDir()], { timeout: 300_000 });
        if (x.code !== 0) throw new Error(`The Lite engine could not be unpacked: ${lastLine(x.stderr)}`);
      }
    }
    await run('/bin/chmod', ['755', vmm()], { timeout: 10_000 });
    // Downloaded files carry the quarantine flag; docatz-vmm is signed, this only spares a first-run prompt.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dir()], { timeout: 30_000 });
    if (!(await this.installed())) throw new Error('The Lite engine does not answer as expected (version / protocol)');
  }

  private saved(): Saved | null {
    try {
      const c = JSON.parse(readFileSync(configFile(), 'utf8')) as Saved & { memoryMiB: number };
      return { cpus: c.cpus, memoryMiB: c.memoryMiB, diskGiB: c.diskGiB ?? 0, rosetta: c.rosetta };
    } catch {
      return null;
    }
  }

  async status(): Promise<BackendStatus> {
    const manager = `DoCatz Lite ${LITE.version}`;
    if (process.platform !== 'darwin') return { status: 'unsupported', message: 'Lite runs on macOS for now', manager, dir: '', running: null };
    if (Number(process.getSystemVersion().split('.')[0]) < 13) return { status: 'unsupported', message: 'DoCatz needs macOS 13 or newer (Apple’s Virtualization framework)', manager, dir: '', running: null };
    if (!existsSync(dataDisk())) return { status: 'missing', message: 'No Lite engine yet — Start sets it up (about 300 MB to download the first time).', manager, dir: vmDir(), running: null };
    const s = await control<VmmStatus>('status', undefined, 3000).catch(() => null);
    const c = this.saved();
    const running = c ? { cpus: c.cpus, memoryGiB: Math.round(c.memoryMiB / 1024), diskGiB: c.diskGiB || Math.round(statSync(dataDisk()).size / 1024 ** 3), rosetta: c.rosetta } : null;
    if (!s || s.state === 'stopped') return { status: 'stopped', message: '', manager, dir: vmDir(), running };
    const status = s.state === 'running' ? 'running' : s.state === 'error' ? 'error' : s.state;
    return { status, message: status === 'error' ? 'The Lite VM stopped with an error — see the engine log, or Reset' : '', manager, dir: vmDir(), running };
  }

  async start(config: EngineConfig, r: StepReporter): Promise<void> {
    r.step(0);
    if (!(await this.installed())) await this.install(r);
    if (r.signal.aborted) throw new Error('Cancelled');
    r.step(1);
    mkdirSync(vmDir(), { recursive: true });
    const d = await run(vmm(), ['disk', '--path', dataDisk(), '--size-gib', String(config.diskGiB)], { timeout: 60_000 });
    if (d.code !== 0) throw new Error(`The data disk could not be prepared: ${lastLine(d.stdout || d.stderr)}`);
    r.step(2);
    const guest = JSON.parse(readFileSync(join(guestDir(), 'guest.json'), 'utf8')) as { cmdline: string };
    mkdirSync(join(socketPath(), '..'), { recursive: true });
    mkdirSync('/tmp/docatz', { recursive: true });
    const cfg = {
      kernel: join(guestDir(), 'vmlinux'),
      initrd: join(guestDir(), 'initramfs.img'),
      rootfs: join(guestDir(), 'rootfs.img'),
      cmdline: guest.cmdline,
      data: dataDisk(),
      cpus: config.cpus,
      memoryMiB: config.memoryGiB * 1024,
      rosetta: machineArch() === 'arm64' && config.rosetta,
      shares: [{ path: homedir(), readOnly: false }, { path: '/tmp/docatz', readOnly: false }],
      dockerSocket: socketPath(),
      controlSocket: ctlSocket(),
      console: consoleLog(),
      forwardPorts: true,
      balloon: true,
      restoreFrom: null,
      diskGiB: config.diskGiB,
    };
    writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
    // Its own process group, its output in run.log: the VM outlives the process that started it.
    const out = openSync(runLog(), 'a');
    const child = spawn(vmm(), ['run', '--config', configFile()], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    closeSync(out);
    let exited: number | null = null;
    child.on('exit', (code) => (exited = code ?? 1));
    for (let i = 0; i < 240; i++) {
      if (r.signal.aborted) {
        await this.stop().catch(() => undefined);
        throw new Error('Cancelled');
      }
      if (exited !== null) throw new Error(`The Lite VM did not start: ${this.lastError() || `docatz-vmm exited ${exited}`}`);
      const s = await control<VmmStatus>('status', undefined, 2000).catch(() => null);
      if (s?.state === 'running' && s.guest?.docker !== false) break;
      if (s?.state === 'error') throw new Error(`The Lite VM did not start: ${this.lastError() || 'see the engine log'}`);
      if (i === 239) throw new Error('The Lite VM did not answer within 2 minutes — see the engine log');
      await new Promise((res) => setTimeout(res, 500));
    }
    r.step(3);
  }

  /** The last `error` event docatz-vmm wrote (run.log). */
  private lastError(): string {
    try {
      const lines = readFileSync(runLog(), 'utf8').trim().split('\n').reverse();
      for (const l of lines) {
        if (!l.startsWith('{')) continue;
        const e = JSON.parse(l) as { event?: string; message?: string };
        if (e.event === 'error' && e.message) return e.message;
        if (e.event === 'state' && e.message === undefined) break;
      }
    } catch {
      /* no log yet */
    }
    return '';
  }

  async stop(): Promise<void> {
    if (!(await control('status', undefined, 3000).catch(() => null))) return;
    await control('stop', { timeoutSec: 20 }, 30_000).catch(() => null);
    for (let i = 0; i < 60; i++) {
      if (!(await control('status', undefined, 1500).catch(() => null))) return;
      await new Promise((res) => setTimeout(res, 500));
    }
    await control('kill', undefined, 5000).catch(() => null);
  }

  async reset(): Promise<void> {
    await this.stop().catch(() => undefined);
    rmSync(vmDir(), { recursive: true, force: true });
  }

  async trim(): Promise<void> {
    await control('trim', undefined, 120_000);
  }

  /** Same events as Standard's (mountevents.ts): its "time\npath\n" lines go to docatz-vmm's `fsevents`. */
  private events = new MountEvents(
    (onExit) => {
      let lines: string[] = [];
      let tail = '';
      let queue: { path: string; mtime: string }[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        const files = queue.splice(0, 1000);
        if (files.length) void control('fsevents', { files }).catch(() => onExit());
        if (queue.length) timer = setTimeout(flush, 20);
      };
      return {
        write: (text) => {
          const parts = (tail + text).split('\n');
          tail = parts.pop() ?? '';
          lines.push(...parts);
          while (lines.length >= 2) {
            const [mtime, path] = lines.splice(0, 2);
            queue.push({ mtime, path });
          }
          if (!timer && queue.length) timer = setTimeout(flush, 20);
        },
        stop: () => {
          if (timer) clearTimeout(timer);
          queue = [];
          lines = [];
        },
      };
    },
    () => [homedir(), '/tmp/docatz'],
  );

  watchMounts(folders: string[]): void {
    this.events.sync(folders);
  }

  async configure(): Promise<void> {
    /* CPUs, memory, disk and Rosetta are written into config.json at the next start. */
  }

  async log(): Promise<string> {
    const parts: string[] = [];
    for (const f of [runLog(), consoleLog()]) if (existsSync(f)) parts.push(`==> ${f.split('/').pop()} <==\n${readFileSync(f, 'utf8').split('\n').slice(-200).join('\n')}`);
    return parts.join('\n\n') || 'No engine log yet.';
  }

  dispose(): void {
    // The VM runs on its own; only the file events stop with this process.
    this.events.stop();
  }
}
