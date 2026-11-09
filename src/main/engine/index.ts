import { cpus as hostCpus, totalmem } from 'node:os';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineConfig, EngineState, TaskProgress } from '@shared/types';
import { cliInstalled, cliVersion, contextState, inPath, installCli, otherDocker, setContext, setPath } from '../cli';
import { docker } from '../docker/client';
import { Cancelled } from '../download';
import { binDir, dockerHost } from '../paths';
import { isLinux, isWin } from '../platform';
import { store } from '../store';
import type { Backend, BackendStatus } from './backend';
import { LimaBackend } from './lima';
import { WslBackend } from './wsl';
import { LinuxBackend } from './linux';
import { machineArch } from '../machine';

/**
 * The engine (DoCatz TODO #5): one backend per platform, its settings, a start with visible steps, and the state
 * the window, the menu bar and Ask DoCatz read. Docker's own answer (GET /info) is what "running" means: a VM that
 * is up but whose Docker does not answer shows as starting.
 */

const KEY = 'engine';
const GiB = 1024 ** 3;
const host = { cpus: hostCpus().length, memoryGiB: Math.round(totalmem() / GiB), arch: machineArch(), rosetta: process.platform === 'darwin' && process.arch === 'arm64' };

function defaults(): EngineConfig {
  return { cpus: Math.max(2, Math.min(4, Math.floor(host.cpus / 2))), memoryGiB: Math.max(2, Math.min(4, Math.floor(host.memoryGiB / 2))), diskGiB: 64, rosetta: host.rosetta, autoStart: true };
}

function config(): EngineConfig {
  const d = defaults();
  const s = store.extra<Partial<EngineConfig>>(KEY) ?? {};
  const int = (v: unknown, min: number, max: number, fallback: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v as number))) : fallback);
  return {
    cpus: int(s.cpus, 1, host.cpus, d.cpus),
    memoryGiB: int(s.memoryGiB, 1, Math.max(1, host.memoryGiB - 2), d.memoryGiB),
    diskGiB: int(s.diskGiB, 16, 2048, d.diskGiB),
    rosetta: host.rosetta && s.rosetta !== false,
    autoStart: s.autoStart !== false,
  };
}

export class Engine {
  readonly backend: Backend = isWin ? new WslBackend() : isLinux ? new LinuxBackend() : new LimaBackend();
  private task: TaskProgress | null = null;
  private abort: AbortController | null = null;
  private busy: 'starting' | 'stopping' | null = null;
  private last: BackendStatus | null = null;
  private dockerInfo: EngineState['docker'] = null;
  /** Called when anything the window shows changed. */
  onChange: (s: EngineState) => void = () => undefined;
  /** Docker answers now (after a start, or found running at launch). */
  onUp: () => void = () => undefined;

  config(): EngineConfig {
    return config();
  }

  /** Is Docker answering? (cheap: one ping) */
  async up(): Promise<boolean> {
    return docker.ping();
  }

  async state(): Promise<EngineState> {
    const b = await this.backend.status().catch((e): BackendStatus => ({ status: 'error', message: (e as Error).message, manager: '', dir: '', running: null }));
    this.last = b;
    let status = this.busy ?? b.status;
    let message = this.task?.error ?? b.message;
    if (status === 'running') {
      const answers = await docker.ping();
      if (!answers) {
        status = 'starting';
        message = isLinux ? 'Docker Engine is up; it is not answering yet.' : 'The VM is up; Docker is not answering yet.';
        this.dockerInfo = null;
      } else if (!this.dockerInfo) {
        try {
          const [v, info] = await Promise.all([docker.connect(), docker.get<{ NCPU: number; MemTotal: number; OperatingSystem: string }>('/info')]);
          this.dockerInfo = { version: v.Version, apiVersion: v.ApiVersion, os: info.OperatingSystem, kernel: v.KernelVersion, arch: v.Arch, cpus: info.NCPU, memory: info.MemTotal };
        } catch {
          this.dockerInfo = null;
        }
      }
    } else this.dockerInfo = null;
    const c = config();
    const pending: string[] = [];
    if (b.running) {
      if (b.running.cpus !== c.cpus) pending.push(`CPUs ${b.running.cpus} → ${c.cpus}`);
      if (b.running.memoryGiB !== c.memoryGiB) pending.push(`memory ${b.running.memoryGiB} → ${c.memoryGiB} GB`);
      if (b.running.diskGiB < c.diskGiB) pending.push(`disk ${b.running.diskGiB} → ${c.diskGiB} GB`);
      if (host.rosetta && b.running.rosetta !== c.rosetta) pending.push(`Rosetta ${c.rosetta ? 'on' : 'off'}`);
    }
    let diskBytes: number | null = null;
    try {
      // Lima's sparse diffdisk (blocks in use); WSL's dynamically growing ext4.vhdx (its size is what it uses).
      const st = b.dir ? statSync(join(b.dir, isWin ? 'ext4.vhdx' : 'diffdisk')) : null;
      diskBytes = st ? (isWin ? st.size : st.blocks * 512) : null;
    } catch {
      diskBytes = null;
    }
    return {
      backend: this.backend.id,
      status,
      message,
      needs: b.needs ?? null,
      prereqs: b.prereqs ?? null,
      config: c,
      pending: b.status === 'running' || b.status === 'stopped' ? pending : [],
      host,
      dockerHost: dockerHost(),
      docker: status === 'running' ? this.dockerInfo : null,
      vm: b.manager ? { manager: b.manager, dir: b.dir, diskBytes } : null,
      task: this.task,
      context: contextState(),
      cli: { installed: cliInstalled(), version: cliVersion(), dir: binDir(), inPath: await inPath().catch(() => false), otherDocker: otherDocker() },
    };
  }

  /**
   * Tells the window. Several can run at once (a step, the end of a start) and state() takes a while (the VM manager,
   * a ping): only the newest one's answer goes out, so an older "starting" never lands after "running".
   */
  private changeSeq = 0;
  private async changed(): Promise<void> {
    const n = ++this.changeSeq;
    const s = await this.state();
    if (n === this.changeSeq) this.onChange(s);
  }

  private progress(patch: Partial<TaskProgress>): void {
    if (!this.task) return;
    this.task = { ...this.task, ...patch };
    void this.changed();
  }

  /** Sets up what is missing and starts the engine; the steps show in the window. Resolves when Docker answers. */
  async start(): Promise<void> {
    if (this.busy) return;
    // DOCATZ_FAKE_NO_DOCKER (tests, Linux): the install runs although Docker answers.
    if (!process.env.DOCATZ_FAKE_NO_DOCKER && (await docker.ping())) return void this.changed();
    this.busy = 'starting';
    this.abort = new AbortController();
    const steps = [...this.backend.steps, ...(cliInstalled() ? [] : ['Install docker, compose and buildx'])];
    const installing = this.backend.id === 'system' && this.last?.status === 'missing';
    this.task = { kind: 'engine', title: installing ? 'Installing Docker Engine' : 'Starting the engine', steps, step: 0 };
    void this.changed();
    const signal = this.abort.signal;
    try {
      await this.backend.start(config(), {
        step: (i, detail) => this.progress({ step: i, detail, fraction: undefined }),
        detail: (text, fraction) => this.progress({ detail: text, fraction }),
        signal,
      });
      for (let i = 0; i < 90 && !(await docker.ping()); i++) {
        if (signal.aborted) throw new Cancelled();
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!(await docker.ping())) throw new Error(`${isLinux ? 'Docker Engine' : 'The VM'} started, but Docker did not answer — see the engine log`);
      if (!cliInstalled()) {
        this.progress({ step: steps.length - 1, detail: undefined });
        await installCli((text, fraction) => this.progress({ detail: text, fraction }), signal);
      }
      // The context is made (never switched to without the user): docker --context docatz works at once.
      setContext(null);
      this.task = null;
      this.busy = null;
      this.dockerInfo = null;
      this.onUp();
    } catch (e) {
      const cancelled = e instanceof Cancelled || signal.aborted;
      this.task = { ...this.task!, error: cancelled ? undefined : (e as Error).message, cancelled, done: true };
      this.busy = null;
      if (cancelled) this.task = null;
      throw cancelled ? new Error('Cancelled') : e;
    } finally {
      this.abort = null;
      void this.changed();
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  /**
   * Found running at launch, not started by DoCatz: what a start sets up still has to be there — the `docatz` context
   * (DevCatz runs its gateways through it) and DoCatz's CLIs. Usual on Linux, where the system's Docker Engine starts
   * with the computer (#101).
   */
  async adopt(): Promise<void> {
    setContext(null);
    if (!cliInstalled() && !this.task) await this.installCli().catch((e) => console.warn('docker CLI:', (e as Error).message));
  }

  /** Windows: installs WSL (one administrator prompt); the state then asks for a restart. */
  async setupWsl(): Promise<void> {
    if (this.busy || this.task || !this.backend.installPrerequisite) return;
    this.abort = new AbortController();
    this.task = { kind: 'engine', title: 'Installing WSL', steps: ['Approve Windows’ administrator prompt', 'Install WSL 2 and Virtual Machine Platform (a few minutes)', 'Restart Windows to finish'], step: 0 };
    void this.changed();
    try {
      await this.backend.installPrerequisite({
        step: (i, detail) => this.progress({ step: i, detail }),
        detail: (text, fraction) => this.progress({ detail: text, fraction }),
        signal: this.abort.signal,
      });
      // Done: the state now asks for the restart (needs: 'restart'), with why.
      this.task = null;
    } catch (e) {
      const cancelled = (e as Error).message === 'Cancelled';
      this.task = cancelled ? null : { ...this.task!, error: (e as Error).message, done: true };
      if (!cancelled) throw e;
    } finally {
      this.abort = null;
      void this.changed();
    }
  }

  async stop(): Promise<void> {
    if (this.busy) return;
    this.busy = 'stopping';
    void this.changed();
    try {
      await this.backend.stop();
    } finally {
      this.busy = null;
      this.dockerInfo = null;
      void this.changed();
    }
  }

  /** Stop, apply the settings saved while it ran (pending), start. */
  async restart(): Promise<void> {
    await this.stop();
    await this.backend.configure(config());
    await this.start();
  }

  async reset(confirm: string): Promise<void> {
    if (confirm.trim().toLowerCase() !== 'reset') throw new Error('Type reset to confirm');
    this.cancel();
    this.busy = 'stopping';
    void this.changed();
    try {
      await this.backend.reset();
    } finally {
      this.busy = null;
      this.task = null;
      this.dockerInfo = null;
      void this.changed();
    }
  }

  async configure(patch: Partial<EngineConfig>): Promise<EngineState> {
    const next = { ...config(), ...patch };
    store.setExtra(KEY, next);
    // A stopped VM takes the values now; a running one at its next start (the window lists them as pending).
    if (this.last?.status !== 'running' && (patch.cpus !== undefined || patch.memoryGiB !== undefined || patch.diskGiB !== undefined || patch.rosetta !== undefined)) await this.backend.configure(config());
    return this.state();
  }

  async installCli(): Promise<void> {
    this.abort = new AbortController();
    this.task = { kind: 'cli', title: 'Installing docker, compose and buildx', steps: ['Download and install'], step: 0 };
    void this.changed();
    try {
      await installCli((text, fraction) => this.progress({ detail: text, fraction }), this.abort.signal);
      this.task = null;
    } catch (e) {
      this.task = { ...this.task!, error: (e as Error).message, done: true };
      throw e;
    } finally {
      this.abort = null;
      void this.changed();
    }
  }

  async setPath(on: boolean): Promise<EngineState> {
    await setPath(on);
    return this.state();
  }

  async setContext(use: boolean): Promise<EngineState> {
    setContext(use);
    return this.state();
  }

  log(): Promise<string> {
    return this.backend.log();
  }

  dispose(): void {
    this.cancel();
    this.backend.dispose();
  }
}
