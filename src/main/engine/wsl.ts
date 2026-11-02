import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import type { EngineConfig } from '@shared/types';
import { wslRootfs } from '../components';
import { fetchPinned } from '../download';
import { docatzDir, ENGINE_PIPE } from '../paths';
import { lastLine, run } from '../proc';
import { store } from '../store';
import { cancelled, runAsAdminWin } from '../system';
import type { Backend, BackendStatus, StepReporter } from './backend';
import { relayRequests } from './winpaths';

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
/**
 * dockerd as WSL starts it: its output in /var/log/docker.log (the engine log; the last run's kept as docker.log.1),
 * mounts shared (bind propagation for containers), and `host-gateway` pointed at Windows — the distro's default route
 * under WSL 2's NAT — so host.docker.internal reaches this PC as on a Mac, not the WSL VM's own docker0.
 */
const DOCKERD = [
  'mount --make-rshared / 2>/dev/null',
  '[ -f /var/log/docker.log ] && mv -f /var/log/docker.log /var/log/docker.log.1',
  "gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')",
  'exec dockerd --host=unix:///var/run/docker.sock ${gw:+--host-gateway-ip=$gw} >/var/log/docker.log 2>&1',
].join('; ');
/** When DoCatz installed WSL: until Windows has restarted since, the engine waits for that restart. */
const INSTALLED_KEY = 'wslInstalledAt';
const restartPending = () => (store.extra<number>(INSTALLED_KEY) ?? 0) > Date.now() - uptime() * 1000;
/**
 * Virtualisation on in the firmware (SVM / VT-x): a running hypervisor (WSL 2's, Hyper-V's) says yes — Windows then
 * reports the firmware flag as off — else the processor's own flag. null when Windows does not say. A yes stays (it
 * changes only in the BIOS, with a restart); a no is asked again after a minute.
 */
let virt: { at: number; on: boolean | null } | null = null;
async function virtualizationOn(): Promise<boolean | null> {
  if (virt && (virt.on || Date.now() - virt.at < 60_000)) return virt.on;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$c = Get-CimInstance Win32_ComputerSystem; $p = Get-CimInstance Win32_Processor | Select-Object -First 1; "$($c.HypervisorPresent)|$($p.VirtualizationFirmwareEnabled)"'], { timeout: 20_000 });
  const [hv, fw] = r.stdout.trim().split('|');
  const on = r.code !== 0 || fw === undefined ? null : /true/i.test(hv) || /true/i.test(fw);
  virt = { at: Date.now(), on };
  return on;
}
/** --exec: no login shell between wsl.exe and sh (it would expand `$gw`, `$3` … in the script before sh sees it). */
const inDistro = (script: string, o: Parameters<typeof run>[2] = {}) => wsl(['-d', DISTRO, '-u', 'root', '--exec', 'sh', '-c', script], o);

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
    const [st, virtualization] = await Promise.all([existsSync(WSL) ? wsl(['--status']) : null, virtualizationOn()]);
    // `wsl --status` answers 0 also when WSL 2 cannot start a VM ("virtualization is not enabled"): its words say so.
    const vmOff = !!st && /WSL ?2 is unable to start|virtuali[sz]ation is not enabled|HCS_E_HYPERV_NOT_INSTALLED/i.test(text(`${st.stdout}\n${st.stderr}`));
    const notReady = (message: string, needs: BackendStatus['needs'], installed: boolean): BackendStatus => ({ status: 'unsupported', message, manager, dir: '', running: null, needs, prereqs: { virtualization, wsl: false, wslInstalled: installed } });
    if (!st || st.code !== 0 || vmOff) {
      if (restartPending()) return notReady('WSL is installed: restart Windows to finish, then open DoCatz again.', 'restart', true);
      if (virtualization === false) return notReady('Virtualisation is off in the PC’s BIOS / UEFI (SVM Mode on AMD, Intel VT-x on Intel): turn it on there first, then install WSL.', 'install-wsl', vmOff);
      // Installed, but no VM yet: Virtual Machine Platform off, or Windows not restarted since it was turned on.
      if (vmOff) return notReady('WSL is installed, but it cannot start its VM yet: “Virtual Machine Platform” is off, or Windows has not restarted since it was turned on. Install WSL turns it on (administrator approval), then restart Windows.', 'install-wsl', true);
      return notReady('The engine runs on WSL 2, which is not on this PC yet. Install WSL sets it up: Windows asks for administrator approval once, then for a restart.', 'install-wsl', false);
    }
    const prereqs = { virtualization, wsl: true, wslInstalled: true };
    if (!(await this.distroExists())) return { status: 'missing', message: 'No engine yet — Start sets it up.', manager, dir: distroDir(), running: null, prereqs };
    const up = this.daemon !== null && this.daemon.exitCode === null && this.relay !== null;
    return { status: up ? 'running' : 'stopped', message: '', manager, dir: distroDir(), running: null, prereqs };
  }

  /**
   * `wsl --install --no-distribution` as administrator (the UAC prompt): WSL 2 and Virtual Machine Platform, no distro
   * of its own. The elevated PowerShell writes wsl.exe's output to a log line by line; its newest line is the step's
   * detail, so the window shows what Windows is doing (a few minutes: it downloads WSL and turns features on).
   */
  async installPrerequisite(r: StepReporter): Promise<void> {
    const log = join(tmpdir(), `docatz-wsl-install-${process.pid}-${Date.now()}.log`);
    r.step(0, 'If Windows’ question is not in front, click the flashing shield in the taskbar');
    const script = [
      // wsl.exe writes to stderr too: those lines go to the log, not stop the script.
      "$ErrorActionPreference = 'Continue'",
      "$env:WSL_UTF8 = '1'",
      `$log = '${log.replace(/'/g, "''")}'`,
      "Set-Content -LiteralPath $log -Value 'Starting wsl --install' -Encoding UTF8",
      '& "$env:SystemRoot\\System32\\wsl.exe" --install --no-distribution 2>&1 | ForEach-Object { Add-Content -LiteralPath $log -Value ("$_" -replace "`0", \'\') -Encoding UTF8 }',
      'exit $LASTEXITCODE',
    ].join('\n');
    let lastSeen = '';
    const poll = setInterval(() => {
      let t = '';
      try {
        t = readFileSync(log, 'utf8');
      } catch {
        return; // not approved yet
      }
      const line = t.split(/\r?\n|\r/).map((l) => l.replace(/^﻿/, '').trim()).filter(Boolean).pop() ?? '';
      if (line === lastSeen) return;
      if (!lastSeen) r.step(1);
      lastSeen = line;
      const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
      r.detail(line, pct ? Math.min(1, Number(pct[1]) / 100) : undefined);
    }, 500);
    let res: Awaited<ReturnType<typeof runAsAdminWin>>;
    try {
      res = await runAsAdminWin(script, 1_800_000);
    } finally {
      clearInterval(poll);
    }
    let out = '';
    try {
      out = readFileSync(log, 'utf8');
      rmSync(log, { force: true });
    } catch {
      /* never written: the question was declined */
    }
    if (r.signal.aborted || cancelled(res)) throw new Error('Cancelled');
    // 3010: done, a restart finishes it.
    if (!res.ok && !/\b3010\b/.test(res.message)) throw new Error(`WSL could not be installed. ${wslError(out || res.message)}`);
    store.setExtra(INSTALLED_KEY, Date.now());
    r.step(2);
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
      // A dockerd left from a DoCatz that did not quit cleanly (crashed, ended from Task Manager) holds the socket:
      // ours would exit at once and the engine show as stopped while Docker answers. It goes first; ours is the one
      // that keeps the distro alive and ends with DoCatz.
      await inDistro('pkill -x dockerd 2>/dev/null || exit 0; i=0; while pgrep -x dockerd >/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done; pkill -9 -x dockerd 2>/dev/null; rm -f /var/run/docker.pid; true', { timeout: 30_000 });
      this.daemon = spawn(WSL, ['-d', DISTRO, '-u', 'root', '--exec', 'sh', '-c', DOCKERD], { windowsHide: true, stdio: 'ignore' });
      this.daemon.on('exit', () => (this.daemon = null));
    }
    for (let i = 0; i < 60; i++) {
      if (r.signal.aborted) throw new Error('Cancelled');
      if ((await inDistro('test -S /var/run/docker.sock && docker info >/dev/null 2>&1', { timeout: 15_000 })).code === 0) break;
      if (i === 59 || !this.daemon) throw new Error(`Docker did not start inside WSL: ${lastLine(text((await inDistro('tail -n 20 /var/log/docker.log', { timeout: 15_000 })).stdout)) || 'see the engine log'}`);
      await new Promise((res) => setTimeout(res, 1000));
    }
    r.step(3);
    await this.openRelay();
  }

  /** \\.\pipe\docatz_engine → the distro's docker.sock, one socat per connection; bind mounts' Windows paths translated (winpaths.ts). */
  private openRelay(): Promise<void> {
    if (this.relay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer((conn) => {
        const p = spawn(WSL, ['-d', DISTRO, '-u', 'root', '--exec', 'socat', '-', 'UNIX-CONNECT:/var/run/docker.sock'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        relayRequests(conn, p.stdin!);
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
    // Killing wsl.exe does not always end dockerd inside: end the distro, so the engine stops with DoCatz.
    if (this.daemon) spawn(WSL, ['--terminate', DISTRO], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    this.daemon = null;
  }
}
