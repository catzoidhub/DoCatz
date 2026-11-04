<script setup lang="ts">
import { currentOS, keyLabel } from '@shared/platform';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { aiOn, api, askOpen, startStatsPolling, attempt, composeFile, composeOpen, containerTab, containers, engine, findFocus, findText, gatewayFocus, gateways, init, openContainer, openProject, refreshGateways, reportOpen, reportsAsk, section, settingsTab, toast, update, updateOpen, type Section } from '../store';
import askMark from '../assets/logos/ask-catzoid.svg';
import CatMood from './CatMood.vue';
import ContainersView from './ContainersView.vue';
import ImagesView from './ImagesView.vue';
import VolumesView from './VolumesView.vue';
import NetworksView from './NetworksView.vue';
import BuildsView from './BuildsView.vue';
import MonitoringView from './MonitoringView.vue';
import CommandsView from './CommandsView.vue';
import EngineView from './EngineView.vue';
import DcSettings from './DcSettings.vue';
import AskDocatz from './AskDocatz.vue';
import ComposeDialog from './ComposeDialog.vue';
import DcUpdateDialog from './DcUpdateDialog.vue';
import DcReportDialog from './DcReportDialog.vue';
import DcWelcome from './DcWelcome.vue';
import SiblingInstall from './SiblingInstall.vue';
import McatzpPairDialog from './McatzpPairDialog.vue';
import { back, forward } from './nav';

/**
 * The DoCatz window: a section rail (Containers, Images, Volumes, Networks, Engine; Settings below), the section,
 * and the family pieces on top — Ask DoCatz (✦, ⌘K), toasts left of it, the update and report dialogs, the welcome.
 */
const props = defineProps<{ route?: string }>();
const ready = ref(false);
const isWin = currentOS === 'windows';

const ICONS: Record<string, string> = {
  containers: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5v-7ZM6 7a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 6 7Zm2.75.75a.75.75 0 0 1 1.5 0v4.5a.75.75 0 0 1-1.5 0v-4.5ZM14 7a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 14 7Z',
  images: 'M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Zm0 1.68L5.04 6.65 10 9.13l4.96-2.48L10 4.18ZM4.5 7.86v5.21l4.75 2.37v-5.2L4.5 7.85Zm11 0-4.75 2.38v5.2l4.75-2.37V7.86Z',
  volumes: 'M10 2.5c-3.87 0-7 1.12-7 2.5v10c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V5c0-1.38-3.13-2.5-7-2.5Zm0 1.5c3.45 0 5.5.95 5.5 1s-2.05 1-5.5 1-5.5-.95-5.5-1 2.05-1 5.5-1ZM4.5 7.08C5.83 7.66 7.8 8 10 8s4.17-.34 5.5-.92V10c0 .05-2.05 1-5.5 1s-5.5-.95-5.5-1V7.08Zm0 5C5.83 12.66 7.8 13 10 13s4.17-.34 5.5-.92V15c0 .05-2.05 1-5.5 1s-5.5-.95-5.5-1v-2.92Z',
  networks: 'M10 2a2.5 2.5 0 0 1 .75 4.89V9h3.5a1.75 1.75 0 0 1 1.75 1.75v1.36a2.5 2.5 0 1 1-1.5 0v-1.36a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25v1.36a2.5 2.5 0 1 1-1.5 0v-1.36C4 9.78 4.78 9 5.75 9h3.5V6.89A2.5 2.5 0 0 1 10 2Z',
  builds: 'M11.98 1.8a1 1 0 0 1 .87 1.16L12.2 7H16a1 1 0 0 1 .78 1.63l-7 8.6a1 1 0 0 1-1.76-.8L8.67 12.6H5a1 1 0 0 1-.78-1.63l7-8.82a1 1 0 0 1 .76-.35Z',
  engine: 'M7 2a1 1 0 0 1 1 1v1h4V3a1 1 0 1 1 2 0v1h.5A2.5 2.5 0 0 1 17 6.5V7h1a1 1 0 1 1 0 2h-1v2h1a1 1 0 1 1 0 2h-1v.5a2.5 2.5 0 0 1-2.5 2.5H14v1a1 1 0 1 1-2 0v-1H8v1a1 1 0 1 1-2 0v-1h-.5A2.5 2.5 0 0 1 3 13.5V13H2a1 1 0 1 1 0-2h1V9H2a1 1 0 1 1 0-2h1v-.5A2.5 2.5 0 0 1 5.5 4H6V3a1 1 0 0 1 1-1Zm0 5a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-5A.5.5 0 0 0 13 7H7Z',
  monitoring: 'M3 3.75A.75.75 0 0 1 3.75 3h.5a.75.75 0 0 1 .75.75v11.5h11.25a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-.75.75H3.75A.75.75 0 0 1 3 16.5V3.75Zm11.53 2.72a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0L8.5 9.56l-1.97 1.97a.75.75 0 1 1-1.06-1.06l2.5-2.5a.75.75 0 0 1 1.06 0L10.5 9.44l2.97-2.97a.75.75 0 0 1 1.06 0Z',
  commands: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11Zm3.22 2.72a.75.75 0 0 0 0 1.06L8.94 11l-2.72 2.72a.75.75 0 1 0 1.06 1.06l3.25-3.25a.75.75 0 0 0 0-1.06L7.28 7.22a.75.75 0 0 0-1.06 0ZM11 13.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z',
  cog: 'M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
};
const RAIL: { id: Section; label: string }[] = [
  { id: 'containers', label: 'Containers' },
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
  { id: 'builds', label: 'Builds' },
  { id: 'engine', label: 'Engine' },
];
/** A group of its own under a divider (as OrbStack's): what runs now, and the commands to drive it. */
const TOOLS: { id: Section; label: string }[] = [
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'commands', label: 'Commands' },
];
const running = computed(() => containers.value.filter((c) => c.state === 'running').length);
const engineDot = computed(() => {
  const s = engine.value?.status;
  if (s === 'running') return 'bg-success';
  if (s === 'starting' || s === 'stopping') return 'bg-warning';
  if (s === 'error') return 'bg-error';
  return 'bg-base-content/25';
});

/** A place from a link or the tray: containers/<name>, compose/<path>, settings[/<tab>], engine … */
function openRoute(route: string) {
  const [head, ...rest] = route.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (head === 'containers') {
    section.value = 'containers';
    if (arg) {
      openContainer.value = arg;
      containerTab.value = 'info';
    }
  } else if (head === 'compose') {
    // The project started from this file (DevCatz's `<site>-dev` too): its containers in front, the file to Up / rebuild.
    section.value = 'containers';
    const dir = arg.replace(/[\\/][^\\/]+$/, '');
    const running = containers.value.find((c) => c.workingDir === dir);
    if (running?.project) findText.value = running.project;
    composeFile.value = arg;
    composeOpen.value = !running;
  } else if (head === 'gateways' || head === 'services') {
    // docatz://gateways?kind=<kind> / docatz://services?kind=<kind> (DevCatz's "Open in DoCatz"): the service in the
    // DevCatz Services group — its project or container when it runs here, else its row (Install) highlighted.
    section.value = 'containers';
    findText.value = '';
    gatewayFocus.value = arg || null;
    void refreshGateways().then(() => {
      // Without DevCatz's list (an older DevCatz wrote bridge.json), the project's own name finds it.
      const g = gateways.value.find((x) => x.kind === arg) ?? { project: `devcatz-${head === 'services' ? 'svc' : 'gw'}-${arg}`, container: null };
      const here = (n: string | null) => !!n && containers.value.some((c) => c.project === n || c.name === n);
      if (g.project && here(g.project)) openProject.value = g.project;
      else if (g.container && here(g.container)) openContainer.value = g.container;
    });
  } else if (head === 'settings') {
    section.value = 'settings';
    if (arg) settingsTab.value = arg as typeof settingsTab.value;
  } else if (['images', 'volumes', 'networks', 'builds', 'engine', 'monitoring', 'commands'].includes(head)) section.value = head as Section;
}

const askOn = aiOn('ask');

onMounted(async () => {
  await init();
  startStatsPolling();
  api.onOpen(openRoute);
  api.onCommand(({ command }) => {
    if (command.startsWith('section:')) section.value = command.slice(8) as Section;
    else if (command === 'settings') section.value = section.value === 'settings' ? 'containers' : 'settings';
    else if (command === 'about') {
      settingsTab.value = 'about';
      section.value = 'settings';
    } else if (command === 'checkUpdates') {
      updateOpen.value = true;
      if (!['available', 'downloading', 'downloaded'].includes(update.value?.status ?? '')) void api.updateCheck();
    } else if (command === 'reportBug') reportOpen.value = 'bug';
    else if (command === 'sendFeedback') reportOpen.value = 'idea';
    else if (command === 'openCompose') {
      composeFile.value = null;
      composeOpen.value = true;
    } else if (command === 'engineStart') void attempt(() => api.engineStart());
    else if (command === 'engineStop') void attempt(() => api.engineStop());
    else if (command === 'engineRestart') void attempt(() => api.engineRestart());
    else if (command === 'refresh') void api.containers().then((l) => (containers.value = l)).catch(() => undefined);
    else if (command === 'find') findFocus.value++;
    else if (command === 'askDocatz') {
      // With AI (or Ask) off the menu item leads to where it is turned on, instead of doing nothing (Catzoid #35).
      if (askOn.value) askOpen.value = !askOpen.value;
      else {
        settingsTab.value = 'ai';
        section.value = 'settings';
      }
    } else if (command === 'navBack') back();
    else if (command === 'navForward') forward();
  });
  window.addEventListener('mouseup', onMouseNav);
  if (isWin) {
    menuKeys = new Set(await api.menuShortcuts());
    window.addEventListener('keydown', onMenuKey);
  }
  ready.value = true;
  if (props.route) openRoute(props.route);
});

/** Mouse buttons 4 / 5 (back / forward). */
function onMouseNav(e: MouseEvent) {
  if (e.button === 3) back();
  else if (e.button === 4) forward();
  else return;
  e.preventDefault();
}
onBeforeUnmount(() => {
  window.removeEventListener('mouseup', onMouseNav);
  window.removeEventListener('keydown', onMenuKey);
});

/** Windows: no menu bar — the ☰ button opens the app menu, and shortcuts the page left alone run its items. */
let menuKeys = new Set<string>();
const CODE_KEY: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Backspace: 'backspace', Delete: 'delete', Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab', Escape: 'escape' };
function onMenuKey(e: KeyboardEvent) {
  if (e.defaultPrevented || !(e.ctrlKey || e.altKey) || e.metaKey) return;
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^(Digit|Numpad)\d$/.test(e.code) ? e.code.slice(-1) : /^F\d+$/.test(e.code) ? e.code.toLowerCase() : CODE_KEY[e.code];
  if (!key) return;
  const combo = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', key].filter(Boolean).join('+');
  if (!menuKeys.has(combo)) return;
  e.preventDefault();
  void api.menuKey(combo);
}
function openAppMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  void api.appMenu(r.left, r.bottom + 4);
}
</script>

<template>
  <div class="relative flex h-full text-sm">
    <!-- Section rail. The top stays free for the window's traffic lights. -->
    <nav class="flex w-24 shrink-0 flex-col items-center gap-1 border-r border-base-300/60 bg-base-200/60 pb-3 backdrop-blur-xl">
      <div class="drag flex h-14 w-full shrink-0 items-end justify-center pb-1">
        <button v-if="isWin" class="no-drag btn btn-ghost btn-xs btn-square" title="Menu: every DoCatz command and its shortcut" @click="openAppMenu">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M3 5a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Zm0 5a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Zm1 4a1 1 0 1 0 0 2h12a1 1 0 1 0 0-2H4Z" /></svg>
        </button>
      </div>
      <div class="rail-scroll no-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-3">
        <button
          v-for="(r, i) in RAIL"
          :key="r.id"
          class="rail-item relative shrink-0"
          :class="{ 'is-active': section === r.id }"
          :style="{ '--rail-c': `var(--c-${r.id})` }"
          :title="`${r.label} (${keyLabel(`mod+${i + 1}`)})`"
          @click="section = r.id"
        >
          <span class="rail-icon"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS[r.id]" /></svg></span>
          {{ r.label }}
          <span v-if="r.id === 'containers' && running" class="absolute top-1 right-3 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-content ring-2 ring-base-200" :title="`${running} running`">{{ running }}</span>
          <span v-if="r.id === 'engine'" class="absolute top-1.5 right-4 size-2 rounded-full ring-2 ring-base-200" :class="engineDot" :title="`Engine: ${engine?.status ?? '…'}`" />
        </button>
        <!-- Monitoring and Commands: a group of their own -->
        <div class="my-1.5 h-px w-12 shrink-0 bg-base-content/15" />
        <button
          v-for="(r, i) in TOOLS"
          :key="r.id"
          class="rail-item relative shrink-0"
          :class="{ 'is-active': section === r.id }"
          :style="{ '--rail-c': `var(--c-${r.id})` }"
          :title="`${r.label} (${keyLabel(`mod+${i + 7}`)})`"
          @click="section = r.id"
        >
          <span class="rail-icon"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS[r.id]" /></svg></span>
          {{ r.label }}
        </button>
      </div>
      <div class="mb-2 h-px w-12 shrink-0 bg-base-content/15" />
      <button class="rail-item relative shrink-0" :class="{ 'is-active': section === 'settings' }" style="--rail-c: var(--c-settings)" :title="`Settings (${keyLabel('mod+,')})`" @click="section = 'settings'">
        <span class="rail-icon"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.cog" /></svg></span>
        Settings
        <span v-if="update?.status === 'available' || update?.status === 'downloaded'" class="absolute top-1.5 right-4 size-2 rounded-full bg-primary ring-2 ring-base-200" :title="`DoCatz ${update.version} is available`" />
      </button>
    </nav>

    <main class="min-w-0 flex-1 bg-base-100">
      <div v-if="!ready" class="grid h-full place-items-center opacity-60"><span class="loading loading-spinner" /></div>
      <template v-else>
        <ContainersView v-if="section === 'containers'" />
        <ImagesView v-else-if="section === 'images'" />
        <VolumesView v-else-if="section === 'volumes'" />
        <NetworksView v-else-if="section === 'networks'" />
        <BuildsView v-else-if="section === 'builds'" />
        <MonitoringView v-else-if="section === 'monitoring'" />
        <CommandsView v-else-if="section === 'commands'" />
        <EngineView v-else-if="section === 'engine'" />
        <DcSettings v-else-if="section === 'settings'" />
      </template>
    </main>

    <AskDocatz v-if="askOpen" @close="askOpen = false" />
    <button v-if="ready && askOn && !askOpen" class="ask-fab no-drag" :title="`Ask DoCatz (${keyLabel('mod+K')}): say what to do in plain words`" aria-label="Ask DoCatz" @click="askOpen = true"><span><img :src="askMark" alt="" /></span></button>
    <ComposeDialog v-if="ready && composeOpen" @close="composeOpen = false" />
    <DcUpdateDialog v-if="ready && updateOpen" @close="updateOpen = false" />
    <DcReportDialog v-if="ready && reportOpen" :kind="reportOpen" @close="reportOpen = null" />
    <DcWelcome v-if="ready" />
    <SiblingInstall />
    <McatzpPairDialog />

    <!-- Asked once, after the first error: send crash reports? (Catzoid #65) -->
    <dialog v-if="reportsAsk" open class="modal modal-open">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-3">
          <CatMood mood="error" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">DoCatz ran into an error</h3>
            <p class="text-sm opacity-70">Send crash reports so it gets fixed? They carry the error message and where in DoCatz it happened — never environment values, log lines or file paths. Change it any time in Settings → General.</p>
          </div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="api.reportConfigure(false); reportsAsk = false">Don’t send</button>
          <button class="btn btn-primary btn-sm" @click="api.reportConfigure(true); reportsAsk = false">Send crash reports</button>
        </div>
      </div>
    </dialog>

    <div v-if="toast" class="toast toast-end z-50" :class="{ 'is-beside-fab': askOn && !askOpen }">
      <div role="alert" class="alert alert-soft shadow-lg" :class="{ 'alert-error': toast.kind === 'error', 'alert-success': toast.kind === 'success', 'alert-info': toast.kind === 'info' }">
        <CatMood :mood="toast.kind" class="-my-1 size-8 shrink-0" />
        <span class="max-w-md text-sm">{{ toast.text }}</span>
        <button class="btn btn-ghost btn-xs" @click="toast = null">✕</button>
      </div>
    </div>
  </div>
</template>
