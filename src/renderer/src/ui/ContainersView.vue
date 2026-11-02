<script setup lang="ts">
import { keyLabel } from '@shared/platform';
import { computed, nextTick, ref, watch } from 'vue';
import type { DcComposeAction, DcContainer } from '@shared/types';
import { api, attempt, bytes, composeFile, composeOpen, containers, editProjectPrefs, engineUp, findFocus, findText, isFavorite, liveStats, moveToGroup, notify, openContainer, openProject, PROJECT_ICON, projectPrefs, projectTab, runs, toggleFavorite, token, type ProjectTab } from '../store';
import { useListView } from '../listview';
import PopMenu from '../components/PopMenu.vue';
import ContainerDetail from './ContainerDetail.vue';
import EngineGate from './EngineGate.vue';
import RunPanel from './RunPanel.vue';
import ProjectDetail from './ProjectDetail.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ServiceMark from './ServiceMark.vue';
import { frameworkTag } from '../frameworks';

/**
 * Containers (DoCatz TODO #12), arranged as DevCatz's sites: compose projects in Favorites, the user's own groups and
 * the rest, in the drag-and-drop order (or by name, or without groups); Running only. Drag a project to reorder it or
 * drop it into a group / Favorites; right-click for the same. Each project folds open to its services; containers of
 * no project sit at the bottom. The right side is the open project or container.
 */

const STAR = 'M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z';
const listView = useListView('docatz.projectList');
const view = listView.view;
const search = ref<HTMLInputElement | null>(null);
watch(findFocus, () => nextTick(() => search.value?.focus()));

// ---- projects, in the user's order
const q = computed(() => findText.value.trim().toLowerCase());
const matches = (c: DcContainer) => !q.value || [c.name, c.image, c.project ?? '', c.service ?? ''].some((x) => x.toLowerCase().includes(q.value));
const byProject = computed(() => {
  const m = new Map<string, DcContainer[]>();
  for (const c of containers.value) if (c.project) m.set(c.project, [...(m.get(c.project) ?? []), c]);
  return m;
});
/** A project's containers as the list shows them (search and Running only applied). */
const shownOf = (p: string) => (byProject.value.get(p) ?? []).filter((c) => (!view.value.runningOnly || c.state === 'running') && (matches(c) || p.toLowerCase().includes(q.value)));
const ordered = computed(() => {
  const names = [...byProject.value.keys()];
  if (view.value.sort === 'name') return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const idx = new Map(projectPrefs.value.order.map((n, i) => [n, i]));
  return names.map((n, i) => ({ n, k: idx.get(n) ?? 1e6 + i })).sort((a, b) => a.k - b.k || a.n.localeCompare(b.n)).map((x) => x.n);
});

interface Section {
  key: string;
  title: string;
  projects: string[];
  group?: string;
  collapsed: boolean;
}
const sections = computed<Section[]>(() => {
  const filtering = q.value !== '' || view.value.runningOnly;
  const visible = (p: string) => shownOf(p).length > 0;
  const all = ordered.value.filter(visible);
  const mk = (key: string, title: string, projects: string[], extra: Partial<Section> = {}): Section => ({ key, title, projects, collapsed: q.value ? false : listView.isCollapsed(key), ...extra });
  const out: Section[] = [];
  const favs = all.filter((p) => isFavorite(p));
  if (favs.length) out.push(mk('fav', 'Favorites', favs));
  if (view.value.group === 'none') {
    if (all.length) out.push(mk('rest', out.length ? 'All projects' : '', all));
    return out;
  }
  const grouped = new Set<string>();
  for (const g of projectPrefs.value.groups) {
    const members = ordered.value.filter((p) => g.projects.includes(p));
    members.forEach((p) => grouped.add(p));
    const shown = members.filter(visible);
    if (!filtering || shown.length) out.push(mk(`g:${g.name}`, g.name, shown, { group: g.name, collapsed: q.value ? false : g.collapsed }));
  }
  const rest = all.filter((p) => !grouped.has(p));
  if (rest.length) out.push(mk('rest', out.length ? 'Other projects' : '', rest));
  return out;
});
/** Containers of no compose project, at the bottom. */
const loose = computed(() => containers.value.filter((c) => !c.project && (!view.value.runningOnly || c.state === 'running') && matches(c)));
const nothingShown = computed(() => !sections.value.some((s) => s.projects.length) && !loose.value.length);
const toggleSection = (s: Section) => {
  if (s.group) void editProjectPrefs((p) => {
    const g = p.groups.find((x) => x.name === s.group);
    if (g) g.collapsed = !g.collapsed;
  });
  else listView.toggle(s.key);
};
const running = (list: DcContainer[]) => list.filter((c) => c.state === 'running').length;
const sectionRunning = (s: Section) => s.projects.reduce((a, p) => a + running(byProject.value.get(p) ?? []), 0);

// ---- a project's services fold (per window)
const folded = ref<Set<string>>(new Set());
const fold = (p: string) => {
  const s = new Set(folded.value);
  if (s.has(p)) s.delete(p);
  else s.add(p);
  folded.value = s;
};

// ---- expand / collapse all: every project's services, and (expanding) every section too
const allProjects = computed(() => sections.value.flatMap((x) => x.projects));
const anyOpen = computed(() => allProjects.value.some((p) => !folded.value.has(p)) || (loose.value.length > 0 && !listView.isCollapsed('loose')));
async function setAll(open: boolean) {
  if (!open) {
    folded.value = new Set([...folded.value, ...byProject.value.keys()]);
    if (!listView.isCollapsed('loose')) listView.toggle('loose');
    return;
  }
  folded.value = new Set();
  for (const x of sections.value) if (!x.group && listView.isCollapsed(x.key)) listView.toggle(x.key);
  if (listView.isCollapsed('loose')) listView.toggle('loose');
  if (projectPrefs.value.groups.some((g) => g.collapsed)) await editProjectPrefs((p) => p.groups.forEach((g) => (g.collapsed = false)));
}

// ---- drag and drop (as DevCatz's sites)
const dragId = ref<string | null>(null);
const dropSection = ref<string | null>(null);
const dropRow = ref<string | null>(null);
function endDrag() {
  dragId.value = null;
  dropSection.value = null;
  dropRow.value = null;
}
async function placeIn(project: string, s: Section) {
  if (s.key === 'fav') {
    if (!isFavorite(project)) await toggleFavorite(project);
  } else if (view.value.group === 'default') {
    const current = projectPrefs.value.groups.find((g) => g.projects.includes(project))?.name ?? null;
    if (current !== (s.group ?? null)) await moveToGroup(project, s.group ?? null);
  }
}
function onDropSection(s: Section) {
  const id = dragId.value;
  endDrag();
  if (id) void placeIn(id, s);
}
function onDropRow(target: string, s: Section) {
  const id = dragId.value;
  endDrag();
  if (!id || id === target) return;
  void (async () => {
    if (view.value.sort === 'default') {
      const order = ordered.value.filter((x) => x !== id);
      order.splice(order.indexOf(target), 0, id);
      await editProjectPrefs((p) => (p.order = order));
    } else notify('info', 'Sorted by name: switch to the default sort (⇅) to reorder by hand');
    await placeIn(id, s);
  })();
}

// ---- right-click menus and the group name dialog
const menu = ref<{ x: number; y: number; project?: string; group?: string } | null>(null);
function openMenu(e: MouseEvent, target: { project?: string; group?: string }) {
  menu.value = { x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 280), ...target };
}
const groupOf = (p: string) => projectPrefs.value.groups.find((g) => g.projects.includes(p))?.name ?? null;
const nameDialog = ref<{ mode: 'new' | 'rename'; project?: string; from?: string; name: string } | null>(null);
async function saveName() {
  const d = nameDialog.value;
  const name = d?.name.trim();
  if (!d || !name) return;
  if (d.mode === 'new') await moveToGroup(d.project!, name);
  else
    await editProjectPrefs((p) => {
      const g = p.groups.find((x) => x.name === d.from);
      if (g) g.name = name;
    });
  nameDialog.value = null;
}
const removeGroup = (name: string) => editProjectPrefs((p) => (p.groups = p.groups.filter((g) => g.name !== name)));

// ---- live CPU / memory: the shared poll (store.ts)
const stats = liveStats;
const runningCount = computed(() => containers.value.filter((c) => c.state === 'running').length);
const current = computed(() => containers.value.find((c) => c.name === openContainer.value) ?? null);

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
// a framework is only learnt for a service with `build:` — built from source, whatever its image is named (image: halo-api-dev)
const imageLine = (c: DcContainer) => (/^[0-9a-f]{12}$/.test(c.image) || c.framework ? `built from source${c.framework ? ` · ${frameworkTag(c.framework.framework, c.framework.library).label}` : ''}` : c.image);
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
        <button v-if="view.runningOnly" class="no-drag sec-count is-live mb-1" title="Showing running only: click to show all" @click="view.runningOnly = false"><span class="status status-success status-xs" />Running only ✕</button>
        <span v-else-if="runningCount" class="sec-count is-live mb-1"><span class="status status-success status-xs" />{{ runningCount }} running</span>
        <span class="flex-1" />
        <button v-if="containers.length" class="no-drag btn btn-ghost btn-sm btn-square" :title="anyOpen ? 'Collapse all: only the project names' : 'Expand all: every project and section open'" @click="setAll(!anyOpen)">
          <svg v-if="anyOpen" class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.22 2.22a.75.75 0 0 1 1.06 0L10 5.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 3.28a.75.75 0 0 1 0-1.06Zm0 15.56a.75.75 0 0 0 1.06 0L10 14.06l3.72 3.72a.75.75 0 1 0 1.06-1.06l-4.25-4.25a.75.75 0 0 0-1.06 0l-4.25 4.25a.75.75 0 0 0 0 1.06Z" clip-rule="evenodd" /></svg>
          <svg v-else class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2.75a.75.75 0 0 1 .53.22l4.25 4.25a.75.75 0 1 1-1.06 1.06L10 4.56 6.28 8.28a.75.75 0 0 1-1.06-1.06l4.25-4.25a.75.75 0 0 1 .53-.22Zm-4.78 9.97a.75.75 0 0 1 1.06 0L10 16.44l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0l-4.25-4.25a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
        </button>
        <div class="no-drag">
          <PopMenu :items="listView.items.value" align="end" :width="270">
            <button class="btn btn-ghost btn-sm btn-square" :class="{ 'text-primary': listView.custom.value }" title="Filter, sort and group">
              <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path d="M2.5 5.25A.75.75 0 0 1 3.25 4.5h13.5a.75.75 0 0 1 0 1.5H3.25a.75.75 0 0 1-.75-.75Zm2 4A.75.75 0 0 1 5.25 8.5h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Zm2 4a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" /></svg>
            </button>
          </PopMenu>
        </div>
        <button class="no-drag btn btn-ghost btn-sm btn-square" :title="`Open a compose file (${keyLabel('mod+O')})`" @click="openCompose">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
        </button>
      </div>
      <div class="px-3 pb-2">
        <label class="search-box flex min-w-0 items-center gap-2">
          <svg viewBox="0 0 20 20" class="size-3.5 shrink-0 opacity-50" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.27 9.92l3.15 3.16a.75.75 0 1 0 1.06-1.06l-3.16-3.15A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clip-rule="evenodd" /></svg>
          <input ref="search" v-model="findText" class="min-w-0 flex-1 bg-transparent text-sm outline-none" :placeholder="`Find (${keyLabel('mod+F')})`" spellcheck="false" @keydown.esc.stop="findText = ''" />
          <button v-if="findText" class="btn btn-ghost btn-xs btn-circle" title="Clear" @click="findText = ''">×</button>
        </label>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" @dragend="endDrag">
        <p v-if="!containers.length" class="px-3 py-6 text-center text-sm opacity-60">No containers yet. Open a compose file, or run one from a terminal with <span class="font-mono">docker --context docatz run …</span></p>
        <div v-else-if="nothingShown" class="px-3 py-6 text-center text-sm opacity-60">
          <p>{{ q ? `Nothing matches “${findText}”.` : 'Nothing is running.' }}</p>
          <button v-if="view.runningOnly" class="btn btn-ghost btn-xs mt-1" @click="view.runningOnly = false">Show all</button>
        </div>

        <template v-for="s in sections" :key="s.key">
          <!-- a section: Favorites, a group of the user's, the rest — a drop target -->
          <!-- a section heading (as the macOS sidebar): small caps, its count, and the fold chevron on the RIGHT, so the
               left column keeps one chevron per project only -->
          <div
            v-if="s.title"
            class="group/sec mt-3 mb-1 flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 pl-1.5 text-[11px] font-semibold tracking-wide uppercase transition-colors select-none"
            :class="dropSection === s.key ? 'bg-primary/15 text-primary' : 'text-base-content/55 hover:text-base-content/80'"
            :title="s.collapsed ? `Show ${s.title}` : `Hide ${s.title}`"
            @click="toggleSection(s)"
            @dragover.prevent="dropSection = s.key"
            @dragleave="dropSection = dropSection === s.key ? null : dropSection"
            @drop.prevent="onDropSection(s)"
            @contextmenu.prevent="s.group && openMenu($event, { group: s.group })"
          >
            <svg v-if="s.key === 'fav'" class="size-3 shrink-0 text-warning" viewBox="0 0 20 20" fill="currentColor"><path :d="STAR" /></svg>
            <span class="min-w-0 flex-1 truncate">{{ s.title }}</span>
            <span class="sec-count normal-case" :class="{ 'is-live': sectionRunning(s) }">{{ s.projects.length }}</span>
            <svg class="size-3.5 shrink-0 opacity-45 transition group-hover/sec:opacity-90" :class="{ '-rotate-90': s.collapsed }" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
          </div>
          <template v-if="!s.collapsed">
            <p v-if="s.group && !s.projects.length" class="px-3 py-1 text-xs opacity-50">Drop projects here</p>
            <section
              v-for="project in s.projects"
              :key="s.key + project"
              class="mb-1"
              draggable="true"
              :class="{ 'drop-before': dropRow === s.key + project && dragId !== project, 'opacity-40': dragId === project }"
              @dragstart="dragId = project"
              @dragover.prevent.stop="dropRow = s.key + project"
              @dragleave="dropRow = dropRow === s.key + project ? null : dropRow"
              @drop.prevent.stop="onDropRow(project, s)"
            >
              <!-- the compose project: its name, how many run, compose actions on hover -->
              <div class="group flex items-center gap-1 rounded-lg py-1.5 pr-2 pl-0.5 transition-colors" :class="openProject === project ? 'bg-primary/15' : 'hover:bg-base-300/40'" @contextmenu.prevent="openMenu($event, { project })">
                <!-- fold / unfold its services: a clear chevron on the left, as a tree -->
                <button class="grid size-5 shrink-0 place-items-center rounded-md opacity-60 transition hover:bg-base-300/70 hover:opacity-100" :title="folded.has(project) ? `Show ${project}’s services` : `Hide ${project}’s services`" :aria-expanded="!folded.has(project)" @click.stop="fold(project)">
                  <svg viewBox="0 0 20 20" class="size-4 transition-transform duration-150" :class="{ '-rotate-90': folded.has(project) }" fill="currentColor"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
                </button>
                <button class="flex min-w-0 flex-1 items-center gap-2 text-left" :title="`${project}: General, Environment, Domains, Containers, Monitoring`" @click="showProject(project)">
                  <span class="grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-primary"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path :d="PROJECT_ICON" /></svg></span>
                  <span class="truncate text-[13px] font-semibold tracking-tight" :class="{ 'text-primary': openProject === project }">{{ project }}</span>
                  <span class="sec-count shrink-0" :class="{ 'is-live': running(byProject.get(project) ?? []) }">{{ running(byProject.get(project) ?? []) }}/{{ (byProject.get(project) ?? []).length }}</span>
                </button>
                <!-- the star: filled for a favorite, an outline on hover otherwise; a click toggles it -->
                <button
                  class="btn btn-ghost btn-xs btn-square shrink-0"
                  :class="isFavorite(project) ? 'text-warning' : 'hidden opacity-50 group-hover:inline-flex hover:opacity-100'"
                  :title="isFavorite(project) ? 'Remove from Favorites' : 'Add to Favorites'"
                  @click.stop="toggleFavorite(project)"
                >
                  <svg viewBox="0 0 20 20" class="size-3.5" :fill="isFavorite(project) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path :d="STAR" /></svg>
                </button>
                <div class="hidden shrink-0 items-center group-hover:flex">
                  <button class="btn btn-ghost btn-xs btn-square" title=".env in DoCatz" @click="showProject(project, 'env')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path fill-rule="evenodd" d="M8 7a5 5 0 1 1 3.61 4.804l-1.903 1.903A1 1 0 0 1 9 14H8v1a1 1 0 0 1-1 1H6v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2a1 1 0 0 1 .293-.707L8.196 8.39A5.002 5.002 0 0 1 8 7Zm5-3a.75.75 0 0 0 0 1.5A1.5 1.5 0 0 1 14.5 7 .75.75 0 0 0 16 7a3 3 0 0 0-3-3Z" clip-rule="evenodd" /></svg></button>
                  <button class="btn btn-ghost btn-xs btn-square" title="docker compose up" @click="compose(project, 'up')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.86l8.2-4.9a1 1 0 0 0 0-1.72l-8.2-4.9a1 1 0 0 0-.2-.04Z" /></svg></button>
                  <button class="btn btn-ghost btn-xs btn-square" title="docker compose stop" @click="compose(project, 'stop')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg></button>
                </div>
              </div>
              <ul v-show="!folded.has(project)" class="mt-0.5 ml-[1.9rem] space-y-0.5 border-l border-base-300/60 pl-2">
                <li v-for="c in shownOf(project)" :key="c.id">
                  <div class="group flex cursor-default items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors" :class="openContainer === c.name ? 'bg-primary/15 ring-1 ring-primary/30' : 'hover:bg-base-300/40'" @click="openContainer = c.name">
                    <span class="relative shrink-0" :title="c.status">
                      <ServiceMark :container="c" :dim="c.state !== 'running'" />
                      <span class="status status-xs absolute -right-0.5 -bottom-0.5 ring-2 ring-base-200" :class="dot(c) || 'bg-base-content/30'" />
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        <span class="truncate text-[13px] font-medium">{{ c.service ?? c.name }}</span>
                        <span v-if="c.health === 'unhealthy'" class="badge badge-error badge-soft badge-xs">unhealthy</span>
                      </div>
                      <div class="truncate text-[11px] opacity-55">{{ imageLine(c) }}<template v-if="portLine(c)"> · {{ portLine(c) }}</template></div>
                    </div>
                    <span v-if="stats[c.id]" class="shrink-0 text-right font-mono text-[10px] leading-tight opacity-55 group-hover:hidden">{{ stats[c.id].cpu.toFixed(0) }}%<br />{{ bytes(stats[c.id].memUsed) }}</span>
                    <div class="hidden shrink-0 items-center group-hover:flex" @click.stop>
                      <span v-if="busy[c.id]" class="loading loading-spinner loading-xs" />
                      <template v-else>
                        <button v-if="c.url && c.state === 'running'" class="btn btn-ghost btn-xs btn-square" :title="`Open ${c.url}`" @click="api.openUrl(c.url)"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M11 3a1 1 0 1 0 0 2h2.59l-6.3 6.29a1 1 0 1 0 1.42 1.42L15 6.41V9a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-5ZM5 5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3a1 1 0 1 0-2 0v3H5V7h3a1 1 0 0 0 0-2H5Z" /></svg></button>
                        <button v-if="c.state === 'running'" class="btn btn-ghost btn-xs btn-square" title="Stop" @click="act(c, 'stop')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg></button>
                        <button v-else class="btn btn-ghost btn-xs btn-square" title="Start" @click="act(c, 'start')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.86l8.2-4.9a1 1 0 0 0 0-1.72l-8.2-4.9a1 1 0 0 0-.2-.04Z" /></svg></button>
                        <button class="btn btn-ghost btn-xs btn-square" title="Restart" @click="act(c, 'restart')"><svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path fill-rule="evenodd" d="M15.3 7.3A6 6 0 1 0 16 11a1 1 0 1 1 2 0 8 8 0 1 1-2.3-5.6V4a1 1 0 1 1 2 0v4a1 1 0 0 1-1 1h-4a1 1 0 1 1 0-2h2.6Z" clip-rule="evenodd" /></svg></button>
                      </template>
                    </div>
                  </div>
                </li>
              </ul>
            </section>
          </template>
        </template>

        <!-- containers of no compose project -->
        <template v-if="loose.length">
          <div class="group/sec mt-3 mb-1 flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 pl-1.5 text-[11px] font-semibold tracking-wide uppercase text-base-content/55 transition-colors select-none hover:text-base-content/80" @click="listView.toggle('loose')">
            <span class="min-w-0 flex-1 truncate">Other containers</span>
            <span class="sec-count normal-case">{{ loose.length }}</span>
            <svg class="size-3.5 shrink-0 opacity-45 transition group-hover/sec:opacity-90" :class="{ '-rotate-90': listView.isCollapsed('loose') }" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
          </div>
          <ul v-if="!listView.isCollapsed('loose')" class="space-y-0.5">
            <li v-for="c in loose" :key="c.id">
              <div class="group flex cursor-default items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors" :class="openContainer === c.name ? 'bg-primary/15 ring-1 ring-primary/30' : 'hover:bg-base-300/40'" @click="openContainer = c.name">
                <span class="relative shrink-0" :title="c.status">
                  <ServiceMark :container="c" :dim="c.state !== 'running'" />
                  <span class="status status-xs absolute -right-0.5 -bottom-0.5 ring-2 ring-base-200" :class="dot(c) || 'bg-base-content/30'" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-[13px] font-medium">{{ c.name }}</div>
                  <div class="truncate text-[11px] opacity-55">{{ imageLine(c) }}<template v-if="portLine(c)"> · {{ portLine(c) }}</template></div>
                </div>
                <span v-if="stats[c.id]" class="shrink-0 text-right font-mono text-[10px] leading-tight opacity-55">{{ stats[c.id].cpu.toFixed(0) }}%<br />{{ bytes(stats[c.id].memUsed) }}</span>
              </div>
            </li>
          </ul>
        </template>
      </div>
      <RunPanel v-if="run" :run="run" @close="runToken = null" />
    </aside>

    <!-- the open project or container -->
    <ProjectDetail v-if="openProject && projectContainers.length" :key="openProject" :project="openProject" :containers="projectContainers" :stats="stats" class="min-w-0 flex-1" />
    <ContainerDetail v-else-if="current" :key="current.id" :container="current" :stats="stats[current.id] ?? null" class="min-w-0 flex-1" />
    <div v-else class="drag grid min-w-0 flex-1 place-items-center p-8 text-center">
      <div class="no-drag max-w-sm space-y-3">
        <p class="text-base font-semibold tracking-tight">{{ containers.length ? 'Pick a project or a container' : 'Nothing running yet' }}</p>
        <p class="text-sm opacity-60">Drag projects to reorder them or into a group; right-click a project to star it or put it in a group.</p>
        <button class="btn btn-primary btn-sm" @click="openCompose">Open a compose file…</button>
      </div>
    </div>

    <!-- right-click menu of a project or a group -->
    <template v-if="menu">
      <div class="fixed inset-0 z-40" @click="menu = null" @contextmenu.prevent="menu = null" />
      <ul role="menu" class="menu fixed z-50 w-56 rounded-box border border-base-300 bg-base-100 p-1.5 text-sm shadow-xl" :style="{ top: `${menu.y}px`, left: `${menu.x}px` }">
        <template v-if="menu.project">
          <li class="menu-title px-2 py-1 text-[10px] opacity-50">{{ menu.project }}</li>
          <li><button @click="toggleFavorite(menu.project!); menu = null">{{ isFavorite(menu.project) ? 'Remove from Favorites' : 'Add to Favorites' }}</button></li>
          <li class="menu-title mt-1 px-2 text-[10px] opacity-50">Group</li>
          <li v-for="g in projectPrefs.groups" :key="g.name"><button :class="{ 'menu-active': groupOf(menu.project) === g.name }" @click="moveToGroup(menu.project!, g.name); menu = null">{{ g.name }}</button></li>
          <li><button @click="nameDialog = { mode: 'new', project: menu.project!, name: '' }; menu = null">New group…</button></li>
          <li v-if="groupOf(menu.project)"><button @click="moveToGroup(menu.project!, null); menu = null">Remove from {{ groupOf(menu.project) }}</button></li>
        </template>
        <template v-else-if="menu.group">
          <li class="menu-title px-2 py-1 text-[10px] opacity-50">{{ menu.group }}</li>
          <li><button @click="nameDialog = { mode: 'rename', from: menu.group!, name: menu.group! }; menu = null">Rename group…</button></li>
          <li><button class="text-error" @click="removeGroup(menu.group!); menu = null">Delete group (projects stay)</button></li>
        </template>
      </ul>
    </template>

    <dialog v-if="nameDialog" open class="modal modal-open z-[1000]" @keydown.esc="nameDialog = null">
      <form class="modal-box w-[24rem] max-w-[95vw] space-y-3" @submit.prevent="saveName">
        <h3 class="text-lg font-semibold tracking-tight">{{ nameDialog.mode === 'new' ? `Put ${nameDialog.project} in a new group` : 'Rename the group' }}</h3>
        <input v-model="nameDialog.name" class="input input-sm w-full" placeholder="Group name" maxlength="60" autofocus />
        <div class="modal-action"><button type="button" class="btn btn-ghost btn-sm" @click="nameDialog = null">Cancel</button><button class="btn btn-primary btn-sm" :disabled="!nameDialog.name.trim()">{{ nameDialog.mode === 'new' ? 'Create' : 'Rename' }}</button></div>
      </form>
      <div class="modal-backdrop" @click="nameDialog = null" />
    </dialog>

    <ConfirmDialog v-if="confirmDown" :title="`Take ${confirmDown} down?`" :text="`docker compose down stops and removes ${confirmDown}’s containers and networks. Its volumes (your data) stay.`" confirm="Down" tone="error" @cancel="confirmDown = null" @ok="compose(confirmDown!, 'down'); confirmDown = null" />
  </div>
</template>
