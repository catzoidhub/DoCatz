import type { EngineBackendId, EngineConfig, EngineStatus } from '@shared/types';

/**
 * The VM layer behind one interface (DoCatz TODO #1 / #29): Lima on Apple's Virtualization.framework on macOS, a
 * WSL2 distro on Windows. Everything above it (the Docker API client, the app) only sees a socket. A later own helper
 * on Virtualization.framework would be one more Backend.
 */

export interface BackendStatus {
  status: EngineStatus;
  message: string;
  /** The VM manager's name and version (Lima 2.2.1, WSL 2.4.13). */
  manager: string;
  /** The VM's folder on the host. */
  dir: string;
  /** What the VM runs with now (null: not created). */
  running: { cpus: number; memoryGiB: number; diskGiB: number; rosetta: boolean } | null;
}

/** A step of a setup / start, for the progress shown in the window. */
export interface StepReporter {
  step(index: number, detail?: string): void;
  detail(text: string, fraction?: number): void;
  signal: AbortSignal;
}

export interface Backend {
  readonly id: EngineBackendId;
  /** The steps start() reports, in order (the window shows them all). */
  readonly steps: string[];
  status(): Promise<BackendStatus>;
  /** Downloads what is missing, creates the VM when there is none, starts it and waits for Docker's socket. */
  start(config: EngineConfig, r: StepReporter): Promise<void>;
  stop(): Promise<void>;
  /** Deletes the VM and its disk. */
  reset(): Promise<void>;
  /** Applies CPU / memory / disk / Rosetta to a stopped VM (some need a restart, the window says which). */
  configure(config: EngineConfig): Promise<void>;
  /** The VM manager's log, for problems. */
  log(): Promise<string>;
  /** Stops anything DoCatz itself keeps running for the engine (Windows: the relay) when DoCatz quits. */
  dispose(): void;
}
