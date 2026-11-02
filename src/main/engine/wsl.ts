import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import type { EngineConfig } from '@shared/types';
import { wslRootfs } from '../components';
import { fetchPinned } from '../download';
import { docatzDir, ENGINE_PIPE } from '../paths';
import { lastLine, run } from '../proc';
import type { Backend, BackendStatus, StepReporter } from './backend';

/**
 * Windows: a WSL2 distro of DoCatz's own (Alpine, dockerd from apk) — DoCatz TODO #29. NOT TESTED YET: written with
 * the Mac version so the code is Windows-ready from the start; the first Windows test round checks it.
 *
 * - The distro `docatz` is imported from Alpine's minimal root file system into ~/.docatz/vm/wsl.
 * - dockerd runs as a child of DoCatz (`wsl.exe -d docatz -u root -- dockerd`): WSL ends a distro once no wsl.exe
 *   process uses it, so the engine runs while DoCatz runs.
 * - The named pipe \\.\pipe\docatz_engine relays each connection to /var/run/docker.sock through
 *   `wsl.exe … socat`, so the docker CLI and DoCatz talk to it like Docker Desktop's pipe.
 * - Published ports reach Windows' localhost through WSL2's own localhost forwarding.
 * - CPU / memory are WSL-wide settings (%USERPROFILE%\.wslconfig), so DoCatz shows them but does not change them.
 */

const DISTRO = 'docatz';
const WSL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
const distroDir = () => docatzDir('vm', 'wsl');

/** wsl.exe writes UTF-16LE when its output goes to a pipe. */
const text = (s: string) => s.replace(/\u0000/g, '');

/** What wsl.exe's own answers mean, in words a user can act on (its last line is only "If this error was unexpected…"). */
const WSL_ERRORS: [RegExp, string][] = [
  [/HCS_E_HYPERV_NOT_INSTALLED|virtuali[sz]ation is not enabled/i, 'WSL 2 needs virtualisation: turn on “Virtual Machine Platform” (Windows features) and virtualisation in the PC’s firmware (BIOS / UEFI), then restart. In a virtual machine, its host has to allow nested virtualisation.'],
  [/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|not installed/i, 'WSL is not installed: run “wsl --install --no-distribution” in an administrator terminal, restart, then start the engine again.'],
  [/ERROR_FILE_NOT_FOUND|cannot find the file/i, 'WSL could not find the downloaded Linux files: start the engine again to download them anew.'],
];
/** The useful part of a failed wsl.exe call: a known error in plain words, else its first line and error code. */
function wslError(out: string): string {
  const t = text(out);
  const known = WSL_ERRORS.find(([re]) => re.test(t));
  if (known) return known[1];
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(If this error was unexpected|For information|For more information)/i.test(l));
  const code = lines.find((l) => /^Error code:/i.test(l));
  return [lines.find((l) => !/^Error code:/i.test(l)), code].filter(Boolean).join(' ') || lastLine(t);
}
const wsl = (args: string[], o: Parameters<typeof run>[2] = {}) => run(WSL, args, { timeout: 60_000, ...o, env: { ...process.env, WSL_UTF8: '1' } });
const inDistro = (script: string, o: Parameters<typeof run>[2] = {}) => wsl(['-d', DISTRO, '-u', 'root', '--', 'sh', '-c', script], o);

export class WslBackend implements Backend {
  readonly id = 'wsl' as const;
  readonly steps = ['Download the Linux image', 'Create the WSL distro', 'Start Docker', 'Connect to Docker'];
  private daemon: ChildProcess | null = null;
  private relay: Server | null = null;

  private async distroExists(): Promise<boolean> {
    const r = await wsl(['--list', '--quiet']);
    return r.code === 0 && text(r.stdout).split(/\r?\n/).some((l) => l.trim() === DISTRO);
  }

  async status(): Promise<BackendStatus> {
    const manager = 'WSL 2';
    if (process.platform !== 'win32') return { status: 'unsupported', message: 'WSL runs the engine on Windows only', manager, dir: '', running: null };
    if (!existsSync(WSL) || (await wsl(['--status'])).code !== 0) return { status: 'unsupported', message: 'Turn on WSL first: run “wsl --install” in an administrator terminal, restart, then open DoCatz again.', manager, dir: '', running: null };
    if (!(await this.distroExists())) return { status: 'missing', message: 'No engine yet — Start sets it up.', manager, dir: distroDir(), running: null };
    const up = this.daemon !== null && this.daemon.exitCode === null && this.relay !== null;
    return { status: up ? 'running' : 'stopped', message: up ? '' : '', manager, dir: distroDir(), running: null };
  }

  async start(_config: EngineConfig, r: StepReporter): Promise<void> {
    r.step(0);
    const exists = await this.distroExists();
    let rootfs = '';
    if (!exists) rootfs = await fetchPinned(wslRootfs(), (f, got, total) => r.detail(`${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`, f), r.signal);
    r.step(1);
    if (!exists) {
      const i = await wsl(['--import', DISTRO, distroDir(), rootfs, '--version', '2'], { timeout: 300_000, signal: r.signal });
      if (i.code !== 0) throw new Error(`The WSL distro could not be created. ${wslError(i.stderr || i.stdout)}`);
      const a = await inDistro('apk add --no-cache docker socat iptables ip6tables', { timeout: 600_000, signal: r.signal, onLine: (l) => r.detail(text(l)) });
      if (a.code !== 0) throw new Error(`Docker could not be installed in the distro: ${wslError(a.stderr || a.stdout)}`);
    }
    r.step(2);
    if (!this.daemon || this.daemon.exitCode !== null) {
      this.daemon = spawn(WSL, ['-d', DISTRO, '-u', 'root', '--', 'dockerd', '--host=unix:///var/run/docker.sock'], { windowsHide: true, stdio: 'ignore' });
      this.daemon.on('exit', () => (this.daemon = null));
    }
    for (let i = 0; i < 60; i++) {
      if (r.signal.aborted) throw new Error('Cancelled');
      if ((await inDistro('test -S /var/run/docker.sock && docker info >/dev/null 2>&1', { timeout: 15_000 })).code === 0) break;
      if (i === 59) throw new Error('Docker did not start inside WSL');
      await new Promise((res) => setTimeout(res, 1000));
    }
    r.step(3);
    await this.openRelay();
  }

  /** \\.\pipe\docatz_engine → the distro's docker.sock, one socat per connection. */
  private openRelay(): Promise<void> {
    if (this.relay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer((conn) => {
        const p = spawn(WSL, ['-d', DISTRO, '-u', 'root', '--', 'socat', '-', 'UNIX-CONNECT:/var/run/docker.sock'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        conn.pipe(p.stdin!);
        p.stdout!.pipe(conn);
        const end = () => {
          conn.destroy();
          p.kill();
        };
        conn.on('close', end);
        conn.on('error', end);
        p.on('exit', end);
      });
      server.once('error', reject);
      server.listen(ENGINE_PIPE, () => {
        this.relay = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.relay?.close();
    this.relay = null;
    await inDistro('pkill dockerd; true', { timeout: 30_000 });
    this.daemon?.kill();
    this.daemon = null;
    await wsl(['--terminate', DISTRO]);
  }

  async reset(): Promise<void> {
    await this.stop().catch(() => undefined);
    await wsl(['--unregister', DISTRO], { timeout: 120_000 });
    rmSync(distroDir(), { recursive: true, force: true });
  }

  async configure(): Promise<void> {
    /* WSL-wide settings (.wslconfig): shown, not changed by DoCatz. */
  }

  async log(): Promise<string> {
    const r = await inDistro('tail -n 200 /var/log/docker.log 2>/dev/null || dmesg | tail -n 100', { timeout: 15_000 });
    return text(r.stdout || r.stderr) || 'No engine log yet.';
  }

  dispose(): void {
    this.relay?.close();
    this.daemon?.kill();
  }
}
