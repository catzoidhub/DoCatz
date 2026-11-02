import { computed, ref, watch } from 'vue';
import type { DcAiFeature, DcContainer, DcReportKind, DcRun, DcUpdateState, DoCatzSettings, DoCatzSettingsPatch, EngineState, Theme } from '@shared/types';

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

export type Section = 'containers' | 'images' | 'volumes' | 'networks' | 'builds' | 'engine' | 'settings';
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

export async function refreshContainers(): Promise<void> {
  if (!engineUp.value) {
    containers.value = [];
    return;
  }
  try {
    containers.value = await api.containers();
  } catch {
    containers.value = [];
  }
}

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
  api.onEngine((s) => {
    const wasUp = engineUp.value;
    engine.value = s;
    if (wasUp !== engineUp.value) void refreshContainers();
  });
  api.onChanged(() => {
    changes.value++;
    void refreshContainers();
  });
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
