/**
 * DoCatz — shared types between the main process, the preload bridge and the window. The family parts (settings,
 * AI providers, updates, reports, uninstall) keep the shape DBCatz and DevCatz use.
 */

import { keyLabel } from './platform';

export type Theme = 'system' | 'light' | 'dark';

/** DoCatz's settings (Settings page); kept in config.json, checked in the main process. */
export interface DoCatzSettings {
  theme: Theme;
  ai: DcAiSettings;
}

// ------------------------------------------------------------ AI (Catzoid family #58)

/** Who answers Ask DoCatz. `openai-compatible` is any server speaking OpenAI's /chat/completions (LM Studio, vLLM, a company gateway). */
export type DcAiProvider = 'anthropic' | 'openai' | 'gemini' | 'zai' | 'deepseek' | 'mistral' | 'xai' | 'groq' | 'openrouter' | 'ollama' | 'openai-compatible';
export interface DcAiProviderInfo {
  id: DcAiProvider;
  name: string;
  /** Where its API key is made (empty: no key needed). */
  keyUrl: string;
  /** API base URL; editable for Z.ai (China: open.bigmodel.cn), Ollama and OpenAI-compatible. */
  baseUrl: string;
  /** Models offered before the list is loaded from the provider; the first is the default. */
  models: string[];
}
export const DC_AI_PROVIDERS: DcAiProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { id: 'openai', name: 'OpenAI (GPT)', keyUrl: 'https://platform.openai.com/api-keys', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'] },
  { id: 'gemini', name: 'Google (Gemini)', keyUrl: 'https://aistudio.google.com/apikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'zai', name: 'Z.ai (GLM)', keyUrl: 'https://z.ai/manage-apikey/apikey-list', baseUrl: 'https://api.z.ai/api/paas/v4', models: ['glm-5.3', 'glm-5.2'] },
  { id: 'deepseek', name: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'mistral', name: 'Mistral', keyUrl: 'https://console.mistral.ai/api-keys', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'codestral-latest'] },
  { id: 'xai', name: 'xAI (Grok)', keyUrl: 'https://console.x.ai', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-3-mini'] },
  { id: 'groq', name: 'Groq', keyUrl: 'https://console.groq.com/keys', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
  { id: 'openrouter', name: 'OpenRouter (many models)', keyUrl: 'https://openrouter.ai/keys', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro'] },
  { id: 'ollama', name: 'Ollama (local, offline)', keyUrl: '', baseUrl: 'http://localhost:11434', models: ['qwen2.5-coder', 'llama3.1'] },
  { id: 'openai-compatible', name: 'OpenAI-compatible server', keyUrl: '', baseUrl: 'http://localhost:1234/v1', models: [] },
];
export const aiProvider = (id: DcAiProvider) => DC_AI_PROVIDERS.find((p) => p.id === id) ?? DC_AI_PROVIDERS[0];
export interface DcAiSettings {
  enabled: boolean;
  provider: DcAiProvider;
  /** The chosen model per provider (a listed one or any id the provider knows). */
  models: Partial<Record<DcAiProvider, string>>;
  /** Base URL overrides (Ollama, OpenAI-compatible). */
  baseUrls: Partial<Record<DcAiProvider, string>>;
  /** Providers with an API key stored; keys never reach the window. */
  keys: DcAiProvider[];
  /** AI features switched off (each is on while AI is on; DoCatz's own, not shared). */
  off: DcAiFeature[];
}
export const DC_AI_DEFAULTS: DcAiSettings = { enabled: false, provider: 'anthropic', models: {}, baseUrls: {}, keys: [], off: [] };
/** DoCatz's AI features, each with its own switch in Settings → AI (like DevCatz's). */
export type DcAiFeature = 'ask' | 'logs' | 'compose';
export const DC_AI_FEATURES: { id: DcAiFeature; label: string; hint: string; sends: string }[] = [
  { id: 'ask', label: `Ask DoCatz (${keyLabel('mod+K')})`, hint: 'The ✦ button: plain-word commands ("start shop’s containers") turned into DoCatz steps you run one by one.', sends: 'container names, images, states, compose projects and ports, where you are in DoCatz — never environment values, mounts or secrets' },
  { id: 'logs', label: 'Explain with AI in Logs', hint: 'Explains why a container fails or keeps restarting from the log lines you pick, and what to change.', sends: 'the log lines you pick (obvious secrets masked), the container’s image, state, exit code and restart count' },
  { id: 'compose', label: 'Write and fix compose files and Dockerfiles', hint: 'A compose file or Dockerfile from plain words, or a fix for one that fails — always shown before anything is saved.', sends: 'the file open in the editor (obvious secrets masked) and your request' },
];
export type DoCatzSettingsPatch = { theme?: Theme; ai?: Partial<Omit<DcAiSettings, 'keys'>> };

/** A turn of an AI conversation. */
export interface DcAiTurn {
  role: 'user' | 'assistant';
  text: string;
}
/** Exactly what an AI request sends (Preview what is sent). */
export interface DcAiPreview {
  provider: string;
  model: string;
  system: string;
  messages: DcAiTurn[];
}

// ------------------------------------------------------------ shared domains (DoCatz TODO #61)

/**
 * The default domain, HTTPS certificates and URLs without a port (DoCatz TODO #61): Catzoid/shared.json `domains`, the
 * same values and the same system pieces DevCatz uses — either app can set them up, the other reuses them.
 */
export interface DcDomains {
  /** `localhost` or e.g. `test`. */
  tld: string;
  /** DoCatz serves its container domains over HTTPS (its own switch; the CA is shared). */
  https: boolean;
  /** The shared CA: its certificate, the app that made it, whether this computer trusts it. */
  ca: { cert: string; by: string; trusted: boolean } | null;
  /** Names without a port: on, the app whose proxy :443 / :80 point at, and whether DoCatz's domains answer on it. */
  cleanUrls: { on: boolean; by: string | null; reachesDocatz: boolean; /** Nothing answers on :443 (the app it points at is not running). */ frontDown: boolean };
  /** The ports DoCatz's proxy listens on (loopback only). */
  httpsPort: number;
  httpPort: number;
  /** The resolver: needed for a domain other than .localhost, and on Windows for .localhost too. */
  resolver: { needed: boolean; status: 'ours' | 'foreign' | 'none'; resolves: boolean; dnsError: string | null; zones: string[] };
  /** DevCatz is on this computer. */
  devcatz: boolean;
  /** A setup step running (trust the CA, forwarding, resolver) — the window shows its steps. */
  task: { what: 'ca' | 'urls' | 'dns'; task: TaskProgress } | null;
}
export type DcDomainsPatch = { tld?: string; https?: boolean };

/** Progress of a long task shown in the window (the shape DevCatz uses too). */
export interface TaskProgress {
  kind: string;
  title: string;
  steps: string[];
  step: number;
  detail?: string;
  /** 0–1 while a download runs. */
  fraction?: number;
  done?: boolean;
  error?: string;
  cancelled?: boolean;
}

// ------------------------------------------------------------ engine

export type EngineBackendId = 'lima' | 'wsl';
export type EngineStatus = 'missing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'unsupported';
export interface EngineConfig {
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  /** Apple silicon: run amd64 images through Rosetta (#10). */
  rosetta: boolean;
  /** Start the engine when DoCatz starts. */
  autoStart: boolean;
}
export interface EnginePrereqs {
  /** SVM / VT-x on in the BIOS / UEFI; null when Windows does not say. */
  virtualization: boolean | null;
  /** WSL is on this PC (it may still wait for Virtual Machine Platform or a restart). */
  wslInstalled: boolean;
  /** WSL 2 can run the engine. */
  wsl: boolean;
}
export interface EngineState {
  backend: EngineBackendId;
  status: EngineStatus;
  /** A plain-words line for the status (an error, why it is unsupported). */
  message: string;
  /** Windows: what WSL needs before the engine can run — installing it (one administrator prompt), then a restart. */
  needs: 'install-wsl' | 'restart' | null;
  /** Windows: virtualisation and WSL 2, each found on or not (null on a Mac). */
  prereqs: EnginePrereqs | null;
  config: EngineConfig;
  /** Changes that need a restart of the engine (cpus, memory, Rosetta) or a new VM (disk). */
  pending: string[];
  /** This computer's limits for the sliders. */
  host: { cpus: number; memoryGiB: number; arch: string; rosetta: boolean };
  /** DOCKER_HOST for the engine: unix:///…/docker.sock or npipe:////./pipe/docatz_engine. */
  dockerHost: string;
  /** Docker inside the VM, when it answers. */
  docker: { version: string; apiVersion: string; os: string; kernel: string; arch: string; cpus: number; memory: number } | null;
  /** The VM manager (Lima / WSL) and the VM's folder. */
  vm: { manager: string; dir: string; diskBytes: number | null } | null;
  /** A setup / start in progress (downloads, creating the VM). */
  task: TaskProgress | null;
  /** The `docatz` docker context: made, and whether it is the current one. */
  context: { exists: boolean; current: boolean; currentName: string };
  /** DoCatz's own docker, compose and buildx (#7). */
  cli: { installed: boolean; version: string; dir: string; inPath: boolean; otherDocker: string | null };
}

// ------------------------------------------------------------ containers, images, volumes, networks

/** The framework a service is built from (the same names as DevCatz's), for its mark. */
export type DcFrameworkName =
  | 'nuxt' | 'next' | 'vite-vue' | 'vite-react' | 'vite-svelte' | 'tanstack-start' | 'vite' | 'astro' | 'sveltekit' | 'angular' | 'nestjs' | 'express' | 'node'
  | 'go' | 'rust'
  | 'laravel' | 'codeigniter' | 'yii' | 'symfony' | 'cakephp' | 'wordpress' | 'drupal' | 'joomla' | 'slim' | 'php'
  | 'django' | 'flask' | 'fastapi' | 'litestar' | 'python';
export interface DcFramework {
  framework: DcFrameworkName;
  /** A Go / Rust / Python / Node app's own web framework (gin, axum, starlette, fastify …), when recognised. */
  library: string | null;
}

export interface DcPort {
  private: number;
  public: number | null;
  type: 'tcp' | 'udp' | 'sctp';
  ip: string;
}
export type DcContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
export interface DcContainer {
  id: string;
  name: string;
  image: string;
  state: DcContainerState;
  /** Docker's own words: "Up 3 minutes (healthy)", "Exited (1) 2 hours ago". */
  status: string;
  health: 'healthy' | 'unhealthy' | 'starting' | null;
  created: number;
  /** Compose project and service (labels), when it belongs to one. */
  project: string | null;
  service: string | null;
  /** The compose file folder (com.docker.compose.project.working_dir). */
  workingDir: string | null;
  ports: DcPort[];
  /** https://<service>.<project>.docatz.<tld> or https://<name>.docatz.<tld> — every running container on a network. */
  url: string | null;
  /** A database / cache / mail server (no page to open): its address for the rest of its project, like postgres:5432. */
  inner?: string | null;
  networks: string[];
  /** The container's own IP on its first network (DoCatz's router reaches it inside the VM). */
  ip: string | null;
  /** What its domain name is kept under (`<project>/<service>` or the container's name), and the custom name if set. */
  domainKey: string;
  domainName: string | null;
  /** Built from source: the framework found in its build folder (its mark in the list); null for an image. */
  framework: DcFramework | null;
}
export interface DcContainerDetail extends DcContainer {
  command: string;
  entrypoint: string;
  /** Environment variable names (values only on demand — they may be secrets). */
  envNames: string[];
  mounts: { type: string; source: string; destination: string; rw: boolean }[];
  ips: { network: string; ip: string }[];
  restartPolicy: string;
  restartCount: number;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  platform: string;
  labels: Record<string, string>;
}
export interface DcStats {
  id: string;
  cpu: number;
  memUsed: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
}
export interface DcImage {
  id: string;
  tags: string[];
  size: number;
  created: number;
  /** Containers using it (any state). */
  containers: number;
  dangling: boolean;
}
export interface DcVolume {
  name: string;
  driver: string;
  mountpoint: string;
  created: string;
  project: string | null;
  size: number | null;
  /** Containers using it (any state). */
  containers: string[];
}
export interface DcNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  /** bridge, host, none: Docker's own, never removed. */
  builtin: boolean;
  project: string | null;
  subnet: string;
  containers: string[];
}
export type DcPruneKind = 'containers' | 'images' | 'volumes' | 'networks' | 'build-cache';
/** Prune with a preview of what goes (#14). */
export interface DcPrunePreview {
  kind: DcPruneKind;
  items: { id: string; name: string; size: number | null }[];
  /** Bytes freed, when Docker knows. */
  total: number | null;
}
export interface DcDiskUsage {
  images: { count: number; size: number; reclaimable: number };
  containers: { count: number; size: number; reclaimable: number };
  volumes: { count: number; size: number; reclaimable: number };
  buildCache: { count: number; size: number; reclaimable: number };
}
/** A chunk of a running log follow (by token). */
export interface DcLogChunk {
  token: string;
  lines: { stream: 'stdout' | 'stderr'; time: string; text: string }[];
  ended?: boolean;
  error?: string;
}
/** Output of a terminal session (exec), base64 bytes. */
export interface DcTermData {
  session: string;
  data: string;
  exited?: boolean;
}
export type DcComposeAction = 'up' | 'build-up' | 'down' | 'restart' | 'stop' | 'pull' | 'build';
/** A compose run (up / down / restart / pull / build) or an image pull as it goes (#17). */
export interface DcRun {
  token: string;
  title: string;
  lines: string[];
  done: boolean;
  error?: string;
}
export interface DcComposeProject {
  name: string;
  /** The compose files the project was started with (labels). */
  files: string[];
  dir: string | null;
  containers: number;
  running: number;
}

/** How the user arranges the project list (as DevCatz's sites): favorites, their groups, the drag-and-drop order. */
export interface DcProjectPrefs {
  favorites: string[];
  groups: { name: string; projects: string[]; collapsed: boolean }[];
  order: string[];
}

/** A compose project's own .env in DoCatz (like a Dokploy app's environment). */
export interface DcProjectEnv {
  project: string;
  exists: boolean;
  mtime: number | null;
  /** Values hidden and editing off until unlocked (as DevCatz's .env tab). */
  locked: boolean;
  /** The compose project's folder, and the files a new DoCatz .env can start from. */
  dir: string | null;
  projectEnv: string | null;
  example: string | null;
}

/** A build from BuildKit's history (Builds section). */
export interface DcBuild {
  ref: string;
  name: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running';
  createdAt: number;
  durationMs: number | null;
  steps: { total: number; completed: number; cached: number };
  error: string | null;
}
export interface DcBuildDetail extends DcBuild {
  context: string;
  dockerfile: string;
  target: string;
  platforms: string[];
  /** Base images it pulled (alpine@3.20 …). */
  bases: string[];
  image: string | null;
}

// ------------------------------------------------------------ AI answers

/** Explain with AI in Logs: what the user picked and asked. */
export interface DcLogRequest {
  containerId: string;
  lines: string[];
  /** e.g. "why does it keep restarting?" (empty: explain the errors). */
  prompt: string;
}
export interface DcLogAnswer {
  summary: string;
  cause: string;
  steps: string[];
  /** A fixed compose snippet, Dockerfile line or command, '' when there is none; shown, never run. */
  fix: string;
}
/** Write / fix a compose file or Dockerfile (#20). */
export interface DcFileRequest {
  kind: 'compose' | 'dockerfile';
  /** The file as it is now ('' for a new one). */
  current: string;
  prompt: string;
  /** The error it fails with, when asking for a fix. */
  error?: string;
}
export interface DcFileAnswer {
  file: string;
  explanation: string;
}

export type DcAskKind =
  | 'start-container'
  | 'stop-container'
  | 'restart-container'
  | 'remove-container'
  | 'open-container'
  | 'open-logs'
  | 'open-terminal'
  | 'open-url'
  | 'compose-up'
  | 'compose-down'
  | 'compose-restart'
  | 'start-engine'
  | 'stop-engine'
  | 'prune'
  | 'pull-image'
  | 'open-section'
  | 'set-theme'
  | 'open-settings';
export const DC_ASK_KINDS: DcAskKind[] = ['start-container', 'stop-container', 'restart-container', 'remove-container', 'open-container', 'open-logs', 'open-terminal', 'open-url', 'compose-up', 'compose-down', 'compose-restart', 'start-engine', 'stop-engine', 'prune', 'pull-image', 'open-section', 'set-theme', 'open-settings'];
/** Reviewed and typed before they run (Catzoid #58). */
export const DC_ASK_DESTRUCTIVE: DcAskKind[] = ['remove-container', 'compose-down', 'prune'];
export const DC_ASK_ARGS = ['container', 'project', 'what', 'section', 'tab', 'theme', 'image'] as const;
export type DcAskArg = (typeof DC_ASK_ARGS)[number];
export interface DcAskAction {
  kind: DcAskKind;
  label: string;
  args: Partial<Record<DcAskArg, string>>;
}
export interface DcAskRequest {
  prompt: string;
  history?: DcAiTurn[];
  /** Where the user is: a section and maybe a container. */
  where: { section: string; container?: string };
}
export interface DcAskAnswer {
  explanation: string;
  actions: DcAskAction[];
}

// ------------------------------------------------------------ About, updates, uninstall, reports (Catzoid family)

/** Settings → About (Catzoid family #62): the build, and the shared site address the links are built from. */
export interface AboutInfo {
  version: string;
  arch: string;
  macos: string;
  electron: string;
  chrome: string;
  node: string;
  /** The shared Catzoid site address (Catzoid/shared.json `site`), e.g. https://catzoid.com — no trailing slash. */
  site: string;
  dataDir: string;
}

export type DcUpdateChannel = 'stable' | 'beta';
export interface DcUpdateSettings {
  /** Check 30 s after launch and every 6 h. */
  auto: boolean;
  /** A notification when the automatic check finds a version (once per version). */
  notify: boolean;
  channel: DcUpdateChannel;
  /** "Skip this version": the automatic check stays quiet about it. */
  skipped: string;
}
export interface DcUpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'error';
  current: string;
  version?: string;
  notes?: string;
  size?: number;
  releaseDate?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  error?: string;
  lastChecked?: number;
  source?: 'site' | 'github';
  manual?: boolean;
  settings: DcUpdateSettings;
  /** Where "Download from the site" goes: <site>/download/docatz/<platform>. */
  downloadUrl: string;
}
export interface DcUninstallPlan {
  /** What goes, in plain words, with its path (or Keychain item). */
  items: { label: string; path: string }[];
  /** The settings shared with the other Catzoid apps (shared.json + the "Catzoid AI" Keychain items). */
  shared: { label: string; path: string }[];
  /** Other Catzoid apps still on this computer: the shared settings stay unless the user ticks them. */
  otherApps: string[];
  /** Installed through Homebrew: `brew uninstall --cask docatz` runs too. */
  homebrew: boolean;
  /** Tests (DOCATZ_UNINSTALL_DRY) and unpackaged builds: nothing is removed. */
  dryRun: boolean;
}

export type DcReportKind = 'bug' | 'idea' | 'question';
/** The body of `POST <site>/api/reports` (the Catzoid API's ReportInput). */
export interface DcReport {
  type: 'crash' | 'error' | 'feedback';
  app: 'docatz';
  version: string;
  channel?: string;
  os: string;
  osVersion?: string;
  arch?: string;
  platform?: string;
  message: string;
  stack?: string;
  installId?: string;
  email?: string;
  process?: string;
  extra?: Record<string, unknown>;
  /** Screenshots on a bug report (Catzoid #67): sent as multipart `image` parts, never in the JSON. */
  shots?: ReportShot[];
  /** Preview only: how many screenshots would go with it. */
  screenshots?: string;
}
export interface ReportShot {
  type: 'image/png' | 'image/jpeg';
  data: string;
}
export interface DcReportSettings {
  crash: boolean | null;
  queued: number;
}

export type SiblingApp = 'devcatz' | 'dbcatz' | 'dialcatz';

// ------------------------------------------------------------ API (preload bridge)

export interface DoCatzApi {
  /** App version, the shared Catzoid site address, this computer's platform id ('' when there is no build for it), the sibling apps found. */
  appInfo(): Promise<{ version: string; site: string; platform: string; siblings: Record<SiblingApp, string | null> }>;
  aboutInfo(): Promise<AboutInfo>;
  updateState(): Promise<DcUpdateState>;
  updateCheck(): Promise<DcUpdateState>;
  updateDownload(): Promise<void>;
  updateCancel(): Promise<void>;
  updateSkip(version: string): Promise<DcUpdateState>;
  updateInstall(now: boolean): Promise<void>;
  updateConfigure(patch: Partial<DcUpdateSettings>): Promise<DcUpdateState>;
  reportPreview(kind: DcReportKind, message: string, email: string, shots?: number): Promise<DcReport>;
  reportSend(kind: DcReportKind, message: string, email: string, shots?: ReportShot[]): Promise<'sent' | 'queued'>;
  captureWindow(): Promise<string>;
  reportError(message: string, stack: string): Promise<void>;
  reportSettings(): Promise<DcReportSettings>;
  reportConfigure(crash: boolean): Promise<DcReportSettings>;
  uninstallPlan(): Promise<DcUninstallPlan>;
  uninstallRun(confirm: string, shared: boolean): Promise<DcUninstallPlan>;
  settings(): Promise<DoCatzSettings>;
  setSettings(patch: DoCatzSettingsPatch): Promise<DoCatzSettings>;
  setAiKey(provider: DcAiProvider, key: string): Promise<DoCatzSettings>;
  aiModels(provider: DcAiProvider): Promise<string[]>;
  aiProbe(provider: DcAiProvider, models: string[]): Promise<Record<string, string | null>>;
  aiTest(): Promise<string>;
  aiCancel(token: string): Promise<void>;
  aiAsk(request: DcAskRequest, token?: string): Promise<DcAskAnswer>;
  aiPreviewAsk(request: DcAskRequest): Promise<DcAiPreview>;
  aiExplainLog(request: DcLogRequest, token?: string): Promise<DcLogAnswer>;
  aiPreviewLog(request: DcLogRequest): Promise<DcAiPreview>;
  aiFile(request: DcFileRequest, token?: string): Promise<DcFileAnswer>;
  aiPreviewFile(request: DcFileRequest): Promise<DcAiPreview>;
  openUrl(url: string): Promise<void>;
  reveal(path: string): Promise<void>;
  /** Opens a sibling Catzoid app at a link (devcatz://…, dbcatz://…); false when it is not installed. */
  openSibling(app: SiblingApp, link: string): Promise<boolean>;
  /** Opens a terminal (Terminal on macOS, PowerShell on Windows) running `command` against DoCatz (Commands page). */
  runInTerminal(command: string): Promise<void>;

  // engine
  engineState(): Promise<EngineState>;
  /** Downloads what is missing and creates the VM (first run), then starts it; progress in EngineState.task. */
  engineStart(): Promise<void>;
  engineStop(): Promise<void>;
  engineRestart(): Promise<void>;
  /** Deletes the VM and its disk (every container, image and volume); `confirm` must be "reset". */
  engineReset(confirm: string): Promise<void>;
  engineConfigure(patch: Partial<EngineConfig>): Promise<EngineState>;
  engineCancel(): Promise<void>;
  /** Windows: installs WSL (`wsl --install --no-distribution`, one administrator prompt); a restart finishes it. */
  engineSetupWsl(): Promise<void>;
  /** Asks, then restarts the computer (to finish installing WSL); false when the user chose Later. */
  restartComputer(): Promise<boolean>;
  /** The VM manager's own log (setup / start problems). */
  engineLog(): Promise<string>;
  /** Makes the `docatz` docker context; `use` makes it the current one (false: back to `default`). */
  contextSet(use: boolean): Promise<EngineState>;
  /** Downloads docker, compose and buildx into DoCatz's bin folder (#7). */
  cliInstall(): Promise<void>;
  /** Adds DoCatz's bin folder to PATH (shell profile on macOS, the user's Path on Windows), or takes it out. */
  cliPath(on: boolean): Promise<EngineState>;
  diskUsage(): Promise<DcDiskUsage>;

  // containers
  containers(): Promise<DcContainer[]>;
  container(id: string): Promise<DcContainerDetail>;
  /** The environment values (asked for explicitly: they may be secrets). */
  containerEnv(id: string): Promise<Record<string, string>>;
  containerAction(id: string, action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill'): Promise<void>;
  containerRemove(id: string, volumes: boolean): Promise<void>;
  stats(ids: string[]): Promise<DcStats[]>;
  /** Starts following a container's log; chunks arrive through `onLogs`. `tail` lines first. */
  logsFollow(id: string, tail: number, token: string): Promise<void>;
  logsStop(token: string): Promise<void>;
  /** A shell in the container; output arrives through `onTerm`. Resolves with the session id. */
  termOpen(id: string, cols: number, rows: number): Promise<string>;
  termInput(session: string, data: string): Promise<void>;
  termResize(session: string, cols: number, rows: number): Promise<void>;
  termClose(session: string): Promise<void>;
  /** A folder inside a container (#13). */
  files(id: string, path: string): Promise<{ name: string; dir: boolean; link: boolean; size: number; mode: string; mtime: string }[]>;
  /** Saves a file or folder from a container to the host as a .tar (asks where). */
  fileSave(id: string, path: string): Promise<string | null>;
  projects(): Promise<DcComposeProject[]>;
  /** Picks a compose file (null: cancelled). */
  composePick(): Promise<string | null>;
  composeRun(file: string, action: DcComposeAction, token: string): Promise<void>;
  /** A compose action on a project DoCatz already runs (its files from the labels). */
  composeProject(project: string, action: DcComposeAction, token: string): Promise<void>;
  runCancel(token: string): Promise<void>;
  /** A compose file / Dockerfile as text (for the editor). */
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;

  // images, volumes, networks
  images(): Promise<DcImage[]>;
  imageRemove(id: string, force: boolean): Promise<void>;
  imagePull(ref: string, token: string): Promise<void>;
  volumes(): Promise<DcVolume[]>;
  volumeRemove(name: string): Promise<void>;
  networks(): Promise<DcNetwork[]>;
  networkRemove(id: string): Promise<void>;
  prunePreview(kind: DcPruneKind): Promise<DcPrunePreview>;
  prune(kind: DcPruneKind): Promise<{ removed: number; freed: number }>;

  // the project list's arrangement
  projectPrefs(): Promise<DcProjectPrefs>;
  setProjectPrefs(prefs: DcProjectPrefs): Promise<DcProjectPrefs>;

  // a compose project's own .env in DoCatz
  envState(project: string, dir: string | null): Promise<DcProjectEnv>;
  envRead(project: string): Promise<{ content: string; mtime: number }>;
  /** Saves; resolves with the new mtime. Refused when the file changed since `mtime`. */
  envWrite(project: string, content: string, mtime: number | null): Promise<number>;
  envCreate(project: string, dir: string | null, from: 'env' | 'example' | 'empty'): Promise<DcProjectEnv>;
  envLock(project: string, on: boolean): Promise<DcProjectEnv>;
  envRemove(project: string): Promise<void>;
  /** Per running container of the project, the DoCatz .env keys whose value inside differs (names only, never values). */
  envDrift(project: string): Promise<{ container: string; service: string; keys: string[] }[]>;
  /** The name in front of `.docatz.<tld>` for a container (compose: per service); null = the default name. */
  setDomainName(key: string, name: string | null): Promise<void>;

  // builds (BuildKit history)
  builds(): Promise<DcBuild[]>;
  build(ref: string): Promise<DcBuildDetail>;
  buildLogs(ref: string): Promise<string>;
  buildRemove(ref: string): Promise<void>;

  // domains (shared with DevCatz, #61)
  domains(): Promise<DcDomains>;
  setDomains(patch: DcDomainsPatch): Promise<DcDomains>;
  /** Trusts the shared CA (making or adopting it first) / removes the trust — the OS asks; steps in DcDomains.task. */
  caTrust(on: boolean): Promise<DcDomains>;
  /** Installs / removes the :443 / :80 forwarding (administrator approval once). */
  cleanUrls(on: boolean): Promise<DcDomains>;
  /** Installs / removes the resolver (/etc/resolver, or Windows NRPT rules for .localhost and the domain). */
  resolver(on: boolean): Promise<DcDomains>;

  // window
  appMenu(x: number, y: number): Promise<void>;
  menuShortcuts(): Promise<string[]>;
  menuKey(key: string): Promise<void>;
}

/** Every method of the bridge, registered as `docatz:<name>` IPC handlers. */
export const API_METHODS: (keyof DoCatzApi)[] = [
  'appInfo', 'aboutInfo', 'updateState', 'updateCheck', 'updateDownload', 'updateCancel', 'updateSkip', 'updateInstall', 'updateConfigure', 'reportPreview', 'reportSend', 'captureWindow', 'reportError', 'reportSettings', 'reportConfigure', 'uninstallPlan', 'uninstallRun', 'settings', 'setSettings', 'setAiKey', 'aiModels', 'aiProbe', 'aiTest', 'aiCancel', 'aiAsk', 'aiPreviewAsk', 'aiExplainLog', 'aiPreviewLog', 'aiFile', 'aiPreviewFile', 'openUrl', 'reveal', 'openSibling', 'runInTerminal',
  'engineState', 'engineStart', 'engineStop', 'engineRestart', 'engineReset', 'engineConfigure', 'engineCancel', 'engineSetupWsl', 'restartComputer', 'engineLog', 'contextSet', 'cliInstall', 'cliPath', 'diskUsage',
  'containers', 'container', 'containerEnv', 'containerAction', 'containerRemove', 'stats', 'logsFollow', 'logsStop', 'termOpen', 'termInput', 'termResize', 'termClose', 'files', 'fileSave', 'projects', 'composePick', 'composeRun', 'composeProject', 'runCancel', 'readText', 'writeText',
  'images', 'imageRemove', 'imagePull', 'volumes', 'volumeRemove', 'networks', 'networkRemove', 'prunePreview', 'prune',
  'projectPrefs', 'setProjectPrefs',
  'envState', 'envRead', 'envWrite', 'envCreate', 'envLock', 'envRemove', 'envDrift', 'setDomainName',
  'builds', 'build', 'buildLogs', 'buildRemove',
  'domains', 'setDomains', 'caTrust', 'cleanUrls', 'resolver',
  'appMenu', 'menuShortcuts', 'menuKey',
];
