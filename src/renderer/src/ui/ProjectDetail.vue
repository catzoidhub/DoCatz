<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcComposeAction, DcComposeProject, DcContainer, DcStats } from '@shared/types';
import { api, attempt, bytes, changes, composeFile, composeOpen, containerTab, notify, openContainer, isFavorite, openProject, PROJECT_ICON, projectTab, runs, statsHistory, toggleFavorite, token, type ProjectTab } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DcNavButtons from './DcNavButtons.vue';
import ProjectEnv from './ProjectEnv.vue';
import RunPanel from './RunPanel.vue';
import ServiceMark from './ServiceMark.vue';
import { frameworkTag } from '../frameworks';
import TimeChart, { type Series } from './TimeChart.vue';

/**
 * A compose project's page (as a Dokploy compose service): General (folder, compose files, Up / Restart / Stop /
 * Down / Pull / Build with their output), Environment (its own .env in DoCatz), Domains (each service's name, editable
 * before .docatz.<tld>), Containers (each service, opening its own page) and Monitoring (CPU and memory, live).
 */
const props = defineProps<{ project: string; containers: DcContainer[]; stats: Record<string, DcStats> }>();
const TABS: { id: ProjectTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'env', label: 'Environment' },
  { id: 'domains', label: 'Domains' },
  { id: 'containers', label: 'Containers' },
  { id: 'monitoring', label: 'Monitoring' },
];

const info = ref<DcComposeProject | null>(null);
async function load() {
  info.value = (await api.projects().catch(() => [] as DcComposeProject[])).find((p) => p.name === props.project) ?? null;
}
watch([() => props.project, changes], load, { immediate: true });
const dir = computed(() => info.value?.dir ?? props.containers.find((c) => c.workingDir)?.workingDir ?? null);
const running = computed(() => props.containers.filter((c) => c.state === 'running').length);

// ---- General: compose actions
const runToken = ref<string | null>(null);
const run = computed(() => (runToken.value ? runs.value[runToken.value] : null));
const busy = computed(() => run.value !== null && !run.value.done);
const confirmDown = ref(false);
async function compose(action: DcComposeAction) {
  runToken.value = token();
  await attempt(() => api.composeProject(props.project, action, runToken.value!));
}
function editCompose(file: string) {
  composeFile.value = file;
  composeOpen.value = true;
}

// ---- Domains: one per service, the name before .docatz.<tld> editable
const editing = ref<string | null>(null);
const nameInput = ref('');
const suffixOf = (url: string) => new URL(url).hostname.replace(/^.*?\.(docatz\.)/, '$1');
const nameOf = (url: string) => new URL(url).hostname.slice(0, -(suffixOf(url).length + 1));
function startEdit(c: DcContainer) {
  editing.value = c.id;
  nameInput.value = c.url ? nameOf(c.url) : '';
}
async function saveName(c: DcContainer, name: string | null) {
  if ((await attempt(() => api.setDomainName(c.domainKey, name))) !== undefined) {
    editing.value = null;
    notify('success', name ? `${c.service} is now at ${name}.${c.url ? suffixOf(c.url) : 'docatz.localhost'}` : `${c.service} is back on its default name`);
  }
}

// ---- Containers
function openOne(c: DcContainer) {
  openProject.value = null;
  openContainer.value = c.name;
  containerTab.value = 'info';
}
const dot = (c: DcContainer) => (c.state === 'running' ? (c.health === 'unhealthy' ? 'status-error' : 'status-success') : c.state === 'paused' || c.state === 'restarting' ? 'status-warning' : 'bg-base-content/30');

// ---- Monitoring: charts from the samples the list takes every 5 s (the last 10 minutes)
const PALETTE = ['oklch(70% 0.14 240)', 'oklch(70% 0.16 330)', 'oklch(74% 0.15 78)', 'oklch(70% 0.13 180)', 'oklch(64% 0.17 280)', 'oklch(68% 0.16 28)', 'oklch(70% 0.15 150)'];
const colourOf = (i: number) => PALETTE[i % PALETTE.length];
const cpuSeries = computed<Series[]>(() => props.containers.map((c, i) => ({ name: c.service ?? c.name, color: colourOf(i), points: (statsHistory.value[c.id] ?? []).map((h) => ({ t: h.t, v: h.cpu })) })));
const memSeries = computed<Series[]>(() => props.containers.map((c, i) => ({ name: c.service ?? c.name, color: colourOf(i), points: (statsHistory.value[c.id] ?? []).map((h) => ({ t: h.t, v: h.mem })) })));
/** Bytes per second from the counters (they only grow while a container runs). */
const netSeries = computed<Series[]>(() => {
  const rate = (key: 'rx' | 'tx') => {
    const byTime = new Map<number, number>();
    for (const c of props.containers) {
      const h = statsHistory.value[c.id] ?? [];
      for (let i = 1; i < h.length; i++) {
        const dt = (h[i].t - h[i - 1].t) / 1000;
        const t = Math.round(h[i].t / 5000) * 5000;
        if (dt > 0) byTime.set(t, (byTime.get(t) ?? 0) + Math.max(0, h[i][key] - h[i - 1][key]) / dt);
      }
    }
    return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  };
  return [
    { name: 'Received', color: PALETTE[0], points: rate('rx') },
    { name: 'Sent', color: PALETTE[1], points: rate('tx') },
  ];
});
const totals = computed(() => {
  const list = props.containers.map((c) => props.stats[c.id]).filter(Boolean) as DcStats[];
  return { cpu: list.reduce((a, s) => a + s.cpu, 0), mem: list.reduce((a, s) => a + s.memUsed, 0), rx: list.reduce((a, s) => a + s.netRx, 0), tx: list.reduce((a, s) => a + s.netTx, 0) };
});
const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const rateText = (v: number) => `${bytes(v)}/s`;
</script>

<template>
  <section class="flex h-full min-w-0 flex-col">
    <header class="drag win-top flex h-14 shrink-0 items-end gap-3 border-b border-base-300/60 px-4 pb-2">
      <div class="no-drag"><DcNavButtons /></div>
      <span class="mb-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
        <svg viewBox="0 0 20 20" class="size-5" fill="currentColor"><path :d="PROJECT_ICON" /></svg>
      </span>
      <div class="min-w-0 flex-1 pb-0.5">
        <div class="flex items-center gap-2">
          <h1 class="truncate text-base font-semibold tracking-tight">{{ project }}</h1>
          <button class="no-drag btn btn-ghost btn-xs btn-square" :class="isFavorite(project) ? 'text-warning' : 'opacity-50 hover:opacity-100'" :title="isFavorite(project) ? 'Remove from Favorites' : 'Add to Favorites'" @click="toggleFavorite(project)">
            <svg viewBox="0 0 20 20" class="size-4" :fill="isFavorite(project) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" /></svg>
          </button>
          <span class="badge badge-sm" :class="running ? 'badge-success badge-soft' : 'badge-ghost'">{{ running }}/{{ containers.length }} running</span>
        </div>
        <p class="truncate text-xs opacity-55">Compose project<template v-if="dir"> · {{ dir }}</template></p>
      </div>
      <div class="no-drag flex shrink-0 items-center gap-1">
        <span v-if="busy" class="loading loading-spinner loading-sm mx-2" />
        <button class="btn btn-sm btn-primary" :disabled="busy" title="docker compose up --build: rebuild the images, then recreate what changed (a changed .env included)" @click="compose('build-up')">Build &amp; Up</button>
        <button class="btn btn-sm" :disabled="busy" title="docker compose up: recreates what changed, without building" @click="compose('up')">Up</button>
        <button class="btn btn-sm" :disabled="busy" @click="compose('restart')">Restart</button>
        <button class="btn btn-sm" :disabled="busy" @click="compose('stop')">Stop</button>
        <button class="btn btn-ghost btn-sm btn-square" title="Close" @click="openProject = null">✕</button>
      </div>
    </header>
    <div class="flex shrink-0 items-center gap-1 border-b border-base-300/60 px-4 py-1.5">
      <div role="tablist" class="seg">
        <a v-for="t in TABS" :key="t.id" role="tab" class="seg-item" :class="{ 'is-active': projectTab === t.id }" @click="projectTab = t.id">{{ t.label }}</a>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <!-- General -->
      <div v-if="projectTab === 'general'" class="h-full overflow-y-auto">
        <div class="mx-auto max-w-3xl space-y-4 p-5">
          <div class="card">
            <div class="card-body gap-2">
              <h2>Project</h2>
              <dl class="selectable grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt class="opacity-60">Name</dt><dd class="font-mono text-xs leading-5">{{ project }}</dd>
                <dt class="opacity-60">Folder</dt><dd class="font-mono text-xs leading-5 break-all"><a v-if="dir" class="link-hover cursor-pointer" @click="api.reveal(dir)">{{ dir }}</a><span v-else>—</span></dd>
                <dt class="opacity-60">Services</dt><dd>{{ containers.map((c) => c.service).join(', ') }}</dd>
              </dl>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Frameworks</h2>
              <p class="text-xs opacity-60">What each service is built from (found in its build folder, the way DevCatz detects a site), or the image it runs.</p>
              <ul class="grid gap-2 sm:grid-cols-2">
                <li v-for="c in containers" :key="c.id" class="flex items-center gap-2.5 rounded-box border border-base-300/60 bg-base-200/40 px-3 py-2">
                  <ServiceMark :container="c" size="md" />
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium leading-tight">{{ c.service }}</span>
                    <span class="block truncate text-[11px] leading-tight opacity-60">{{ c.framework ? frameworkTag(c.framework.framework, c.framework.library).label : `image ${c.image}` }}</span>
                  </span>
                </li>
              </ul>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Compose files</h2>
              <p v-if="!info?.files.length" class="text-sm opacity-60">This project was not started from a compose file DoCatz can find.</p>
              <ul v-else class="space-y-1">
                <li v-for="f in info.files" :key="f" class="flex items-center gap-2 text-sm">
                  <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="f">{{ f }}</span>
                  <button class="btn btn-ghost btn-xs" @click="editCompose(f)">Open</button>
                  <button class="btn btn-ghost btn-xs" @click="api.reveal(f)">Show</button>
                </li>
              </ul>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-3">
              <h2>Deploy</h2>
              <p class="text-xs opacity-60">Runs with the project’s .env in DoCatz (Environment tab) when it has one. <b>Build &amp; Up</b> rebuilds the images and recreates every container whose image or environment changed.</p>
              <div class="flex flex-wrap gap-1.5">
                <button class="btn btn-sm btn-primary" :disabled="busy" title="docker compose up --build" @click="compose('build-up')">Build &amp; Up</button>
                <button class="btn btn-sm" :disabled="busy" title="docker compose up, without building" @click="compose('up')">Up</button>
                <button class="btn btn-sm" :disabled="busy" @click="compose('build')">Build</button>
                <button class="btn btn-sm" :disabled="busy" @click="compose('pull')">Pull</button>
                <button class="btn btn-sm" :disabled="busy" @click="compose('restart')">Restart</button>
                <button class="btn btn-sm" :disabled="busy" @click="compose('stop')">Stop</button>
                <button class="btn btn-sm btn-outline btn-error" :disabled="busy" @click="confirmDown = true">Down…</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Environment -->
      <ProjectEnv v-else-if="projectTab === 'env'" :key="project" :project="project" :dir="dir" embedded />

      <!-- Domains -->
      <div v-else-if="projectTab === 'domains'" class="h-full overflow-y-auto">
        <div class="mx-auto max-w-3xl space-y-4 p-5">
          <div class="card">
            <div class="card-body gap-3">
              <h2>Domains</h2>
              <p class="text-xs opacity-60">Each service answers at its own name, no published port needed. Change the part before .docatz; the ending follows Settings → Domains.</p>
              <ul class="divide-y divide-base-300/50">
                <li v-for="c in containers" :key="c.id" class="flex flex-wrap items-center gap-2 py-2">
                  <ServiceMark :container="c" size="sm" />
                  <span class="w-28 truncate text-sm font-medium">{{ c.service }}</span>
                  <template v-if="!c.url && c.inner"><span class="text-xs opacity-60">not a web page — the other services reach it at <code class="font-mono">{{ c.inner }}</code></span></template>
                  <template v-else-if="!c.url"><span class="text-xs opacity-50">{{ c.state === 'running' ? 'no network address' : 'starts with the service' }}</span></template>
                  <template v-else-if="editing === c.id">
                    <form class="flex flex-wrap items-center gap-1.5" @submit.prevent="saveName(c, nameInput.trim() || null)">
                      <input v-model="nameInput" class="input input-sm w-52 font-mono text-xs" spellcheck="false" autofocus @keydown.esc.prevent="editing = null" />
                      <span class="font-mono text-xs opacity-60">.{{ suffixOf(c.url) }}</span>
                      <button class="btn btn-primary btn-xs">Save</button>
                      <button v-if="c.domainName" type="button" class="btn btn-ghost btn-xs" @click="saveName(c, null)">Default</button>
                      <button type="button" class="btn btn-ghost btn-xs" @click="editing = null">Cancel</button>
                    </form>
                  </template>
                  <template v-else>
                    <a class="link min-w-0 flex-1 truncate font-mono text-xs" @click="api.openUrl(c.url)">{{ c.url }}</a>
                    <span v-if="c.domainName" class="badge badge-ghost badge-xs">custom</span>
                    <button class="btn btn-ghost btn-xs" @click="startEdit(c)">Edit</button>
                  </template>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <!-- Containers -->
      <div v-else-if="projectTab === 'containers'" class="h-full overflow-y-auto">
        <div class="mx-auto max-w-3xl p-5">
          <table class="table table-sm">
            <thead><tr><th>Service</th><th>Image</th><th>State</th><th class="text-right">CPU</th><th class="text-right">Memory</th></tr></thead>
            <tbody>
              <tr v-for="c in containers" :key="c.id" class="cursor-pointer hover:bg-base-200/60" @click="openOne(c)">
                <td>
                  <div class="flex items-center gap-2">
                    <ServiceMark :container="c" size="sm" />
                    <span class="font-medium">{{ c.service }}</span>
                  </div>
                </td>
                <td class="font-mono text-xs opacity-70">{{ c.image }}</td>
                <td><span class="flex items-center gap-1.5 text-xs"><span class="status status-xs" :class="dot(c)" />{{ c.status }}</span></td>
                <td class="text-right font-mono text-xs">{{ stats[c.id] ? `${stats[c.id].cpu.toFixed(1)}%` : '—' }}</td>
                <td class="text-right font-mono text-xs">{{ stats[c.id] ? bytes(stats[c.id].memUsed) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Monitoring -->
      <div v-else-if="projectTab === 'monitoring'" class="h-full overflow-y-auto">
        <div class="mx-auto max-w-4xl space-y-4 p-5">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="card"><div class="card-body gap-1"><span class="label-caps">CPU</span><span class="text-2xl font-semibold tabular-nums">{{ pct(totals.cpu) }}</span><span class="text-xs opacity-55">all services · one core = 100%</span></div></div>
            <div class="card"><div class="card-body gap-1"><span class="label-caps">Memory</span><span class="text-2xl font-semibold tabular-nums">{{ bytes(totals.mem) }}</span><span class="text-xs opacity-55">all services</span></div></div>
            <div class="card"><div class="card-body gap-1"><span class="label-caps">Network</span><span class="text-sm tabular-nums">↓ {{ bytes(totals.rx) }} · ↑ {{ bytes(totals.tx) }}</span><span class="text-xs opacity-55">since each started</span></div></div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <div class="flex items-baseline gap-2"><h2 class="flex-1">CPU</h2><span class="text-xs opacity-50">per service, every 5 s, the last 10 minutes</span></div>
              <TimeChart :series="cpuSeries" :format="pct" :min-max="5" />
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Memory</h2>
              <TimeChart :series="memSeries" :format="bytes" :min-max="64 * 1024 * 1024" />
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Network</h2>
              <TimeChart :series="netSeries" :format="rateText" :min-max="1024" :height="140" />
            </div>
          </div>
          <p class="text-xs opacity-50">The charts fill while DoCatz is open (Containers polls every 5 seconds); they start empty after a restart.</p>
        </div>
      </div>
    </div>

    <RunPanel v-if="run" :run="run" tall @close="runToken = null" />
    <ConfirmDialog v-if="confirmDown" :title="`Take ${project} down?`" :text="`docker compose down stops and removes ${project}’s containers and networks. Its volumes (your data) stay.`" confirm="Down" tone="error" @cancel="confirmDown = false" @ok="compose('down'); confirmDown = false" />
  </section>
</template>
