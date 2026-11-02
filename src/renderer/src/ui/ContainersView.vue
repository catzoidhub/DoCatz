<script setup lang="ts">
import { keyLabel } from '@shared/platform';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DcComposeAction, DcContainer, DcStats } from '@shared/types';
import { api, attempt, bytes, composeFile, composeOpen, containers, engineUp, findFocus, findText, openContainer, openProject, recordStats, PROJECT_ICON, projectTab, runs, token, type ProjectTab } from '../store';
import ContainerDetail from './ContainerDetail.vue';
import EngineGate from './EngineGate.vue';
import RunPanel from './RunPanel.vue';
import ProjectDetail from './ProjectDetail.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ServiceMark from './ServiceMark.vue';
import { frameworkTag } from '../frameworks';

/**
 * Containers (DoCatz TODO #12): grouped by compose project, each with its state, ports and domain, and live CPU /
 * memory; a project's header runs compose Up / Restart / Stop / Down on it. The right side is the open container.
 */

const runningOnly = ref(false);
const search = ref<HTMLInputElement | null>(null);
watch(findFocus, () => nextTick(() => search.value?.focus()));

const shown = computed(() => {
  const q = findText.value.trim().toLowerCase();
  return containers.value.filter((c) => (!runningOnly.value || c.state === 'running') && (!q || [c.name, c.image, c.project ?? '', c.service ?? ''].some((x) => x.toLowerCase().includes(q))));
});
const groups = computed(() => {
  const m = new Map<string, DcContainer[]>();
  for (const c of shown.value) m.set(c.project ?? '', [...(m.get(c.project ?? '') ?? []), c]);
  return [...m.entries()].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
});
const collapsed = ref<Set<string>>(new Set());
const toggle = (p: string) => {
  const s = new Set(collapsed.value);
  if (s.has(p)) s.delete(p);
  else s.add(p);
  collapsed.value = s;
};
const runningCount = computed(() => containers.value.filter((c) => c.state === 'running').length);
const current = computed(() => containers.value.find((c) => c.name === openContainer.value) ?? null);

// ---- live CPU / memory of running containers (every 5 s while this view is open)
const stats = ref<Record<string, DcStats>>({});
let timer: ReturnType<typeof setInterval> | null = null;
async function pollStats() {
  const ids = containers.value.filter((c) => c.state === 'running').map((c) => c.id);
  if (!ids.length || document.hidden) return;
  const list = await api.stats(ids).catch(() => [] as DcStats[]);
  stats.value = Object.fromEntries(list.map((s) => [s.id, s]));
  recordStats(list);
}
onMounted(() => {
  void pollStats();
  timer = setInterval(() => void pollStats(), 5000);
});
onBeforeUnmount(() => timer && clearInterval(timer));

// ---- actions
const busy = ref<Record<string, string>>({});
async function act(c: DcContainer, action: 'start' | 'stop' | 'restart') {
  busy.value = { ...busy.value, [c.id]: action };
  await attempt(() => api.containerAction(c.id, action));
  const { [c.id]: _, ...rest } = busy.value;
  busy.value = rest;
}
/** A compose project's page on the right (instead of a container's): clicking its name opens it. */
watch(openContainer, (c) => c && (openProject.value = null));
watch(openProject, (p) => p && (openContainer.value = null));
const projectContainers = computed(() => containers.value.filter((c) => c.project === openProject.value));
function showProject(project: string, tab: ProjectTab = 'general') {
  if (!project) return toggle(project);
  openProject.value = project;
  projectTab.value = tab;
}
const runToken = ref<string | null>(null);
const confirmDown = ref<string | null>(null);
async function compose(project: string, action: DcComposeAction) {
  const t = token();
  runToken.value = t;
  await attempt(() => api.composeProject(project, action, t));
}
const run = computed(() => (runToken.value ? runs.value[runToken.value] : null));

const dot = (c: DcContainer) => (c.state === 'running' ? (c.health === 'unhealthy' ? 'status-error' : c.health === 'starting' ? 'status-warning' : 'status-success') : c.state === 'paused' || c.state === 'restarting' ? 'status-warning' : c.state === 'dead' ? 'status-error' : '');
/** A built image shows as what it was built from, not its bare id. */
const imageLine = (c: DcContainer) => (/^[0-9a-f]{12}$/.test(c.image) || (c.framework && c.project && c.image.startsWith(`${c.project}-`)) ? `built from source${c.framework ? ` · ${frameworkTag(c.framework.framework, c.framework.library).label}` : ''}` : c.image);
const portLine = (c: DcContainer) => c.ports.filter((p) => p.public).map((p) => (p.public === p.private ? `${p.public}` : `${p.public}→${p.private}`)).join(' · ');

function openCompose() {
  composeFile.value = null;
  composeOpen.value = true;
}
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <div v-else class="flex h-full">
    <!-- the list -->
    <aside class="flex w-80 shrink-0 flex-col border-r border-base-300/60 bg-base-200/40">
      <div class="drag win-top flex h-14 shrink-0 items-end gap-1 px-3 pb-2">
        <span class="label-caps pb-1 pl-1">Containers</span>
        <span v-if="runningCount" class="sec-count is-live mb-1"><span class="status status-success status-xs" />{{ runningCount }} running</span>
        <span class="flex-1" />
        <button class="no-drag btn btn-ghost btn-sm btn-square" :title="`Open a compose file (${keyLabel('mod+O')})`" @click="openCompose">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
        </button>
      </div>
      <div class="flex items-center gap-2 px-3 pb-2">
        <label class="search-box flex min-w-0 flex-1 items-center gap-2">
          <svg viewBox="0 0 20 20" class="size-3.5 shrink-0 opacity-50" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.27 9.92l3.15 3.16a.75.75 0 1 0 1.06-1.06l-3.16-3.15A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clip-rule="evenodd" /></svg>
          <input ref="search" v-model="findText" class="min-w-0 flex-1 bg-transparent text-sm outline-none" :placeholder="`Find (${keyLabel('mod+F')})`" spellcheck="false" />
        </label>
        <button class="btn btn-xs" :class="{ 'btn-primary': runningOnly }" title="Show only running containers" @click="runningOnly = !runningOnly">Running</button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <p v-if="!containers.length" class="px-3 py-6 text-center text-sm opacity-60">No containers yet. Open a compose file, or run one from a terminal with <span class="font-mono">docker --context docatz run …</span></p>
        <p v-else-if="!shown.length" class="px-3 py-6 text-center text-sm opacity-60">Nothing matches.</p>
        <section v-for="[project, list] in groups" :key="project" class="mb-3">
          <!-- the compose project: its name, how many run, and compose actions on hover -->
          <div class="group flex items-center gap-2 rounded-lg px-2 py-1.5">
            <button class="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left" :class="{ 'text-primary': project && openProject === project }" :title="project ? `${project}: General, Environment, Domains, Containers, Monitoring` : ''" @click="showProject(project)">
              <span class="grid size-6 shrink-0 place-items-center rounded-md" :class="project ? 'bg-primary/15 text-primary' : 'bg-base-300/60 opacity-70'">
                <svg v-if="project" viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path :d="PROJECT_ICON" /></svg>
                <svg v-else viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5v-7Z" /></svg>
              </span>
              <span class="truncate text-[13px] font-semibold tracking-tight" :class="{ 'opacity-70': !project }">{{ project || 'Other containers' }}</span>
              <span class="sec-count shrink-0" :class="{ 'is-live': list.some((c) => c.state === 'running') }">{{ list.filter((c) => c.state === 'running').length }}/{{ list.length }}</span>
            </button>
            <button class="btn btn-ghost btn-xs btn-square shrink-0" :title="collapsed.has(project) ? 'Show its services' : 'Hide its services'" @click="toggle(project)">
              <svg viewBox="0 0 20 20" class="size-3 opacity-50 transition-transform" :class="{ '-rotate-90': collapsed.has(project) }" fill="currentColor"><path d="M5.5 7.5 10 12l4.5-4.5h-9Z" /></svg>
            </button>
            <div v-if="project" class="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
              <button class="btn btn-ghost btn-xs btn-square" title=".env in DoCatz: the values its containers get" @click="showProject(project, 'env')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path fill-rule="evenodd" d="M8 7a5 5 0 1 1 3.61 4.804l-1.903 1.903A1 1 0 0 1 9 14H8v1a1 1 0 0 1-1 1H6v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2a1 1 0 0 1 .293-.707L8.196 8.39A5.002 5.002 0 0 1 8 7Zm5-3a.75.75 0 0 0 0 1.5A1.5 1.5 0 0 1 14.5 7 .75.75 0 0 0 16 7a3 3 0 0 0-3-3Z" clip-rule="evenodd" /></svg></button>
              <button class="btn btn-ghost btn-xs btn-square" title="docker compose up (recreates what changed)" @click="compose(project, 'up')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.86l8.2-4.9a1 1 0 0 0 0-1.72l-8.2-4.9a1 1 0 0 0-.2-.04Z" /></svg></button>
              <button class="btn btn-ghost btn-xs btn-square" title="docker compose restart" @click="compose(project, 'restart')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path fill-rule="evenodd" d="M15.3 7.3A6 6 0 1 0 16 11a1 1 0 1 1 2 0 8 8 0 1 1-2.3-5.6V4a1 1 0 1 1 2 0v4a1 1 0 0 1-1 1h-4a1 1 0 1 1 0-2h2.6Z" clip-rule="evenodd" /></svg></button>
              <button class="btn btn-ghost btn-xs btn-square" title="docker compose stop" @click="compose(project, 'stop')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg></button>
              <button class="btn btn-ghost btn-xs btn-square text-error" title="docker compose down: removes the containers and networks (volumes stay)" @click="confirmDown = project"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.44c-.8.08-1.59.18-2.38.3a.75.75 0 1 0 .23 1.48l.15-.02.84 10.52A2.75 2.75 0 0 0 7.58 19h4.84a2.75 2.75 0 0 0 2.74-2.53l.84-10.52.15.02a.75.75 0 0 0 .23-1.48c-.79-.12-1.58-.22-2.38-.3v-.44A2.75 2.75 0 0 0 11.25 1h-2.5Z" clip-rule="evenodd" /></svg></button>
            </div>
          </div>
          <ul v-show="!collapsed.has(project)" class="mt-0.5 space-y-0.5 border-l border-base-300/60 pl-2 ml-[1.15rem]">
            <li v-for="c in list" :key="c.id">
              <div class="group flex cursor-default items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors" :class="openContainer === c.name ? 'bg-primary/15 ring-1 ring-primary/30' : 'hover:bg-base-300/40'" @click="openContainer = c.name">
                <!-- what it runs: its logo (or the container icon), with its state on the corner -->
                <span class="relative shrink-0" :title="c.status">
                  <ServiceMark :container="c" :dim="c.state !== 'running'" />
                  <span class="status status-xs absolute -right-0.5 -bottom-0.5 ring-2 ring-base-200" :class="dot(c) || 'bg-base-content/30'" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-[13px] font-medium">{{ c.project && c.service ? c.service : c.name }}</span>
                    <span v-if="c.health === 'unhealthy'" class="badge badge-error badge-soft badge-xs">unhealthy</span>
                  </div>
                  <div class="truncate text-[11px] opacity-55">{{ imageLine(c) }}<template v-if="portLine(c)"> · {{ portLine(c) }}</template></div>
                </div>
                <span v-if="stats[c.id]" class="shrink-0 text-right font-mono text-[10px] leading-tight opacity-55 group-hover:hidden">{{ stats[c.id].cpu.toFixed(0) }}%<br />{{ bytes(stats[c.id].memUsed) }}</span>
                <div class="hidden shrink-0 items-center group-hover:flex" @click.stop>
                  <span v-if="busy[c.id]" class="loading loading-spinner loading-xs" />
                  <template v-else>
                    <button v-if="c.url && c.state === 'running'" class="btn btn-ghost btn-xs btn-square" :title="`Open ${c.url}`" @click="api.openUrl(c.url)">
                      <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M11 3a1 1 0 1 0 0 2h2.59l-6.3 6.29a1 1 0 1 0 1.42 1.42L15 6.41V9a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-5ZM5 5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3a1 1 0 1 0-2 0v3H5V7h3a1 1 0 0 0 0-2H5Z" /></svg>
                    </button>
                    <button v-if="c.state === 'running'" class="btn btn-ghost btn-xs btn-square" title="Stop" @click="act(c, 'stop')">
                      <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
                    </button>
                    <button v-else class="btn btn-ghost btn-xs btn-square" title="Start" @click="act(c, 'start')">
                      <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.86l8.2-4.9a1 1 0 0 0 0-1.72l-8.2-4.9a1 1 0 0 0-.2-.04Z" /></svg>
                    </button>
                    <button class="btn btn-ghost btn-xs btn-square" title="Restart" @click="act(c, 'restart')">
                      <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path fill-rule="evenodd" d="M15.3 7.3A6 6 0 1 0 16 11a1 1 0 1 1 2 0 8 8 0 1 1-2.3-5.6V4a1 1 0 1 1 2 0v4a1 1 0 0 1-1 1h-4a1 1 0 1 1 0-2h2.6Z" clip-rule="evenodd" /></svg>
                    </button>
                  </template>
                </div>
              </div>
            </li>
          </ul>
        </section>
      </div>
      <RunPanel v-if="run" :run="run" @close="runToken = null" />
    </aside>

    <!-- the open container -->
 <ProjectDetail v-if="openProject && projectContainers.length" :key="openProject" :project="openProject" :containers="projectContainers" :stats="stats" class="min-w-0 flex-1" />
    <ContainerDetail v-else-if="current" :key="current.id" :container="current" :stats="stats[current.id] ?? null" class="min-w-0 flex-1" />
    <div v-else class="drag grid min-w-0 flex-1 place-items-center p-8 text-center">
      <div class="no-drag max-w-sm space-y-3">
        <p class="text-base font-semibold tracking-tight">{{ containers.length ? 'Pick a container' : 'Nothing running yet' }}</p>
        <p class="text-sm opacity-60">Its logs, a terminal inside it, its files and live stats open here. Each container that publishes a port gets its own domain.</p>
        <button class="btn btn-primary btn-sm" @click="openCompose">Open a compose file…</button>
      </div>
    </div>

    <ConfirmDialog v-if="confirmDown" :title="`Take ${confirmDown} down?`" :text="`docker compose down stops and removes ${confirmDown}’s containers and networks. Its volumes (your data) stay.`" confirm="Down" tone="error" @cancel="confirmDown = null" @ok="compose(confirmDown!, 'down'); confirmDown = null" />
  </div>
</template>
