import { computed, ref, watch } from 'vue';
import type { DcAiFeature, DcContainer, DcDatabase, DcGateway, DcProjectPrefs, DcStats, DcReportKind, DcRun, DcUpdateState, DoCatzSettings, DoCatzSettingsPatch, EngineState, SiblingApp, TaskProgress, Theme } from '@shared/types';
import { currentOS } from '@shared/platform';

/** The preload bridge (see src/preload/index.ts). */
export const api = window.docatz;

/** The provisional slogan (Catzoid TODO #7 picks the final one; the site's /docatz page shows the same line). */
export const SLOGAN = 'If it fits, it ships.';
export const REPO = 'https://github.com/catzoidhub/DoCatz';

export const toast = ref<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(kind: 'error' | 'success' | 'info', text: string): void {
  toast.value = { kind, text };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), kind === 'error' ? 7000 : 3500);
}

export const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Runs an IPC call and turns failures into a toast. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (success) notify('success', success);
    return r;
  } catch (e) {
    notify('error', errorText(e));
    return undefined;
  }
}

// ---------------------------------------------------------------- where the user is

export type Section = 'containers' | 'images' | 'volumes' | 'networks' | 'builds' | 'engine' | 'monitoring' | 'commands' | 'settings';
export const section = ref<Section>('containers');
/** The open container (by name) in Containers, and its tab. */
export const openContainer = ref<string | null>(null);
export type ContainerTab = 'info' | 'logs' | 'terminal' | 'files' | 'stats';
export const containerTab = ref<ContainerTab>('info');
/** The open compose project's page (as a Dokploy compose service), and its tab. */
export const openProject = ref<string | null>(null);
export type ProjectTab = 'general' | 'env' | 'domains' | 'containers' | 'monitoring';
export const projectTab = ref<ProjectTab>('general');
/** A compose project's icon: a stack of layers (services together), not a folder. */
export const PROJECT_ICON = 'M3.196 12.87l-.825.483a.75.75 0 0 0 0 1.294l7.25 4.25a.75.75 0 0 0 .758 0l7.25-4.25a.75.75 0 0 0 0-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 0 1-2.276 0L3.196 12.87ZM3.196 8.87l-.825.483a.75.75 0 0 0 0 1.294l7.25 4.25a.75.75 0 0 0 .758 0l7.25-4.25a.75.75 0 0 0 0-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 0 1-2.276 0L3.196 8.87ZM10.38 1.103a.75.75 0 0 0-.76 0l-7.25 4.25a.75.75 0 0 0 0 1.294l7.25 4.25a.75.75 0 0 0 .76 0l7.25-4.25a.75.75 0 0 0 0-1.294l-7.25-4.25Z';
/** A compose file open in the compose dialog. */
export const composeFile = ref<string | null>(null);
export const composeOpen = ref(false);
export const settingsTab = ref<'general' | 'domains' | 'ai' | 'updates' | 'about'>('general');
export const findText = ref('');
export const findFocus = ref(0);

// ---------------------------------------------------------------- engine and lists

export const engine = ref<EngineState | null>(null);
export const engineUp = computed(() => engine.value?.status === 'running');
export const containers = ref<DcContainer[]>([]);
/** Bumped on every engine event, so open lists reload. */
export const changes = ref(0);
/** Compose runs and pulls, by token (the newest shows in the run panel). */
export const runs = ref<Record<string, DcRun>>({});

/** Windows: DevCatz Services — its Docker gateways and its servers with no Windows build (main/gateways.ts), reloaded with the list; [] elsewhere. */
export const gateways = ref<DcGateway[]>([]);
/** The gateway a docatz://gateways?kind= link points at, highlighted in its group. */
export const gatewayFocus = ref<string | null>(null);
/**
 * Whether DevCatz is on this PC. These services are DevCatz's: without it there is no DevCatz Services group, and a
 * devcatz-gw-* / devcatz-svc-* project left behind is an ordinary project (nothing else looks after it). Checked with the list, at
 * most every 10 s (DevCatz installed or removed meanwhile shows up then).
 */
export const devcatzInstalled = ref(false);
let devcatzCheckedAt = 0;
export async function refreshGateways(): Promise<void> {
  if (Date.now() - devcatzCheckedAt > 10_000) {
    devcatzCheckedAt = Date.now();
    devcatzInstalled.value = !!(await api.appInfo().catch(() => null))?.siblings.devcatz;
  }
  gateways.value = devcatzInstalled.value ? await api.devcatzGateways().catch(() => gateways.value) : [];
}
/** A DevCatz service's kind from its compose project (devcatz-gw-<kind>, devcatz-svc-<kind>) — Windows with DevCatz installed, where it puts them on DoCatz. */
export const gatewayKindOf = (project: string | null | undefined): string | null =>
  currentOS === 'windows' && devcatzInstalled.value ? (/^devcatz-(?:gw|svc)-([a-z0-9-]+)$/.exec(project ?? '')?.[1] ?? null) : null;
/**
 * Gateways are read-only in DoCatz: DevCatz installs, starts and stops them (it keeps `compose up` attached). DoCatz
 * only opens one there — devcatz://gateways/<kind>.
 */
export async function gatewayLink(kind: string): Promise<boolean> {
  // a service (Typesense, Sonic, Sockudo) has its own page in DevCatz: the link DevCatz gave for it
  const link = gateways.value.find((g) => g.kind === kind)?.link ?? `devcatz://gateways/${encodeURIComponent(kind)}`;
  const ok = await attempt(() => api.openSibling('devcatz', link));
  // Not installed: DoCatz offers Download & Install (SiblingInstall.vue), then opens the gateway there.
  if (ok === false) siblingAsk.value = { which: 'devcatz', link };
  return ok === true;
}
/** Frameworks that make an API (the container gets Open in DialCatz when its project has routes to import), not a site's front end. */
export const API_FRAMEWORKS = new Set(['nestjs', 'express', 'node', 'go', 'rust', 'laravel', 'codeigniter', 'yii', 'symfony', 'cakephp', 'slim', 'php', 'django', 'flask', 'fastapi', 'litestar', 'python']);
/** Laravel's and others' background containers (no requests to send them). */
export const WORKER_NAME = /^(scheduler?|schedule|queue|worker|workers|horizon|cron|reverb|jobs?)(-|_|\d|$)/i;
/**
 * A compose project in DialCatz (#25): dialcatz://open?docatz=<project>[&service=<api service>] shows DialCatz's Import from DoCatz for it —
 * an environment with the project's HTTP services, and their routes. Nothing is imported without the user's click there.
 */
export async function dialcatzLink(project: string, service?: string | null): Promise<boolean> {
  // `service`: the API container it was opened from, DialCatz's baseUrl
  const link = `dialcatz://open?docatz=${encodeURIComponent(project)}${service ? `&service=${encodeURIComponent(service)}` : ''}`;
  const ok = await attempt(() => api.openSibling('dialcatz', link));
  if (ok === false) siblingAsk.value = { which: 'dialcatz', link };
  return ok === true;
}
/** The database containers DBCatz gets (#24): each one's address on this computer, by container id. */
export const databases = ref<Omit<DcDatabase, 'password'>[]>([]);
export const databaseOf = (containerId: string) => databases.value.find((d) => d.containerId === containerId) ?? null;
/**
 * A database container in DBCatz (#24): dbcatz://open?docatz=<id> opens it there as a connection — the user and
 * password its image was started with come from DoCatz's dbcatz/services.json, never through the link.
 */
export async function dbcatzLink(id: string): Promise<boolean> {
  const link = `dbcatz://open?docatz=${encodeURIComponent(id)}`;
  const ok = await attempt(() => api.openSibling('dbcatz', link));
  if (ok === false) siblingAsk.value = { which: 'dbcatz', link };
  return ok === true;
}
/** Another Catzoid app is not installed and a link wants it: the Download & Install dialog, and that install's steps. */
export const siblingAsk = ref<{ which: SiblingApp; link: string } | null>(null);
export const siblingTask = ref<TaskProgress | null>(null);

/** Stats samples per container (the list polls every 5 s), the last 10 minutes — the Monitoring charts read them. */
export const HISTORY_SAMPLES = 120;
export const statsHistory = ref<Record<string, { t: number; cpu: number; mem: number; rx: number; tx: number }[]>>({});
export function recordStats(list: DcStats[]): void {
  const t = Date.now();
  const next = { ...statsHistory.value };
  for (const s of list) next[s.id] = [...(next[s.id] ?? []), { t, cpu: s.cpu, mem: s.memUsed, rx: s.netRx, tx: s.netTx }].slice(-HISTORY_SAMPLES);
  statsHistory.value = next;
}

/** The latest stats of every running container (polled every 5 s while the engine runs and the window is visible). */
export const liveStats = ref<Record<string, DcStats>>({});
let statsTimer: ReturnType<typeof setInterval> | null = null;
async function pollStats(): Promise<void> {
  const ids = containers.value.filter((c) => c.state === 'running').map((c) => c.id);
  if (!engineUp.value || !ids.length || document.hidden) {
    if (!ids.length) liveStats.value = {};
    return;
  }
  const list = await api.stats(ids).catch(() => [] as DcStats[]);
  liveStats.value = Object.fromEntries(list.map((s) => [s.id, s]));
  recordStats(list);
}
export function startStatsPolling(): void {
  if (statsTimer) return;
  void pollStats();
  statsTimer = setInterval(() => void pollStats(), 5000);
}

export async function refreshContainers(): Promise<void> {
  if (!engineUp.value) {
    containers.value = [];
    return;
  }
  // DevCatz's gateway list follows the containers (installs and starts show up as engine events too) — read first, so
  // the gateways never show a moment as ordinary projects before moving to their group.
  if (currentOS === 'windows') await refreshGateways();
  try {
    containers.value = await api.containers();
  } catch {
    containers.value = [];
  }
  databases.value = await api.databases().catch(() => databases.value);
}

// ---------------------------------------------------------------- the project list's arrangement (favorites, groups, order)

export const projectPrefs = ref<DcProjectPrefs>({ favorites: [], groups: [], order: [] });
export async function loadProjectPrefs(): Promise<void> {
  projectPrefs.value = await api.projectPrefs().catch(() => projectPrefs.value);
}
/** Changes a copy of the arrangement and saves it (the main process checks it). */
export async function editProjectPrefs(change: (p: DcProjectPrefs) => void): Promise<void> {
  const next = JSON.parse(JSON.stringify(projectPrefs.value)) as DcProjectPrefs;
  change(next);
  projectPrefs.value = next;
  const saved = await attempt(() => api.setProjectPrefs(next));
  if (saved) projectPrefs.value = saved;
}
export const isFavorite = (project: string) => projectPrefs.value.favorites.includes(project);
export const toggleFavorite = (project: string) =>
  editProjectPrefs((p) => {
    p.favorites = p.favorites.includes(project) ? p.favorites.filter((x) => x !== project) : [...p.favorites, project];
  });
/** Puts a project into a group (made when new), or out of every group with null. */
export const moveToGroup = (project: string, group: string | null) =>
  editProjectPrefs((p) => {
    for (const g of p.groups) g.projects = g.projects.filter((x) => x !== project);
    if (!group) return;
    const g = p.groups.find((x) => x.name.toLowerCase() === group.toLowerCase());
    if (g) g.projects.push(project);
    else p.groups.push({ name: group.trim(), projects: [project], collapsed: false });
  });

// ---------------------------------------------------------------- settings, updates, reports

export const settings = ref<DoCatzSettings | null>(null);
export const update = ref<DcUpdateState | null>(null);
export const updateOpen = ref(false);
export const reportOpen = ref<DcReportKind | null>(null);
export const reportsAsk = ref(false);
export const askOpen = ref(false);

/** True when AI is on and this feature is not switched off (Settings → AI): its buttons show only then. */
export const aiOn = (feature: DcAiFeature) => computed(() => Boolean(settings.value?.ai.enabled && !settings.value.ai.off.includes(feature)));

export async function saveSettings(patch: DoCatzSettingsPatch): Promise<void> {
  const s = await attempt(() => api.setSettings(patch));
  if (s) settings.value = s;
}

/** Light / dark / follow the system: the main process sets nativeTheme; data-theme forces DaisyUI's colours. */
export const theme = computed<Theme>(() => settings.value?.theme ?? 'system');
watch(
  theme,
  (mode) => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  },
  { immediate: true },
);

export async function init(): Promise<void> {
  settings.value = await api.settings();
  api.onSettings((s) => {
    settings.value = s;
  });
  update.value = await api.updateState();
  api.onUpdate((u) => {
    update.value = u;
    if (u.manual && ['none', 'available', 'error'].includes(u.status)) updateOpen.value = true;
  });
  api.onUpdateOpen(() => (updateOpen.value = true));
  api.onReportsAsk(() => (reportsAsk.value = true));
  engine.value = await api.engineState();
  await loadProjectPrefs();
  api.onEngine((s) => {
    const wasUp = engineUp.value;
    engine.value = s;
    if (wasUp !== engineUp.value) void refreshContainers();
  });
  api.onChanged(() => {
    changes.value++;
    void refreshContainers();
  });
  api.onSiblingTask((t) => (siblingTask.value = t));
  api.onRun((r) => {
    runs.value = { ...runs.value, [r.token]: r };
  });
  await refreshContainers();
  window.addEventListener('error', (e) => void api.reportError(e.message, e.error?.stack ?? '').catch(() => undefined));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined;
    void api.reportError(r?.message ?? String(e.reason), r?.stack ?? '').catch(() => undefined);
  });
}

// ---------------------------------------------------------------- formatting

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

export const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
