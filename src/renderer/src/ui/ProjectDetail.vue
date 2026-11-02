<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcComposeAction, DcComposeProject, DcContainer, DcStats } from '@shared/types';
import { api, attempt, bytes, changes, composeFile, composeOpen, containerTab, notify, openContainer, openProject, PROJECT_ICON, projectTab, runs, token, type ProjectTab } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DcNavButtons from './DcNavButtons.vue';
import ProjectEnv from './ProjectEnv.vue';
import RunPanel from './RunPanel.vue';
import { serviceLook } from './logos';

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

// ---- Monitoring: the stats the list polls every 5 s, kept for the last few minutes
const HISTORY = 60;
const history = ref<Record<string, { cpu: number; mem: number }[]>>({});
watch(
  () => props.stats,
  (s) => {
    const next = { ...history.value };
    for (const c of props.containers) {
      const st = s[c.id];
      if (!st) continue;
      next[c.id] = [...(next[c.id] ?? []), { cpu: st.cpu, mem: st.memUsed }].slice(-HISTORY);
    }
    history.value = next;
  },
  { immediate: true, deep: true },
);
const totals = computed(() => {
  const list = props.containers.map((c) => props.stats[c.id]).filter(Boolean) as DcStats[];
  return { cpu: list.reduce((a, s) => a + s.cpu, 0), mem: list.reduce((a, s) => a + s.memUsed, 0), rx: list.reduce((a, s) => a + s.netRx, 0), tx: list.reduce((a, s) => a + s.netTx, 0) };
});
/** A sparkline path for 0…max over HISTORY samples (120 × 28). */
function spark(points: number[], max: number): string {
  if (points.length < 2) return '';
  const m = Math.max(max, ...points, 1e-9);
  const step = 120 / (HISTORY - 1);
  const start = HISTORY - points.length;
  return points.map((v, i) => `${i ? 'L' : 'M'}${((start + i) * step).toFixed(1)},${(27 - (v / m) * 25).toFixed(1)}`).join(' ');
}
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
          <span class="badge badge-sm" :class="running ? 'badge-success badge-soft' : 'badge-ghost'">{{ running }}/{{ containers.length }} running</span>
        </div>
        <p class="truncate text-xs opacity-55">Compose project<template v-if="dir"> · {{ dir }}</template></p>
      </div>
      <div class="no-drag flex shrink-0 items-center gap-1">
        <span v-if="busy" class="loading loading-spinner loading-sm mx-2" />
        <button class="btn btn-sm btn-primary" :disabled="busy" title="docker compose up: recreates what changed" @click="compose('up')">Up</button>
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
              <p class="text-xs opacity-60">Runs with the project’s .env in DoCatz (Environment tab) when it has one.</p>
              <div class="flex flex-wrap gap-1.5">
                <button class="btn btn-sm btn-primary" :disabled="busy" @click="compose('up')">Up</button>
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
                  <img v-if="serviceLook(c.image).logo" :src="serviceLook(c.image).logo!" alt="" class="size-5 rounded" draggable="false" />
                  <span class="w-28 truncate text-sm font-medium">{{ c.service }}</span>
                  <template v-if="!c.url"><span class="text-xs opacity-50">{{ c.state === 'running' ? 'no network address' : 'starts with the service' }}</span></template>
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
                    <span class="grid size-7 place-items-center overflow-hidden rounded-lg border border-base-300/70 bg-base-100">
                      <img v-if="serviceLook(c.image).logo" :src="serviceLook(c.image).logo!" alt="" class="size-5 rounded object-contain" draggable="false" />
                      <svg v-else viewBox="0 0 20 20" class="size-4 text-primary" fill="currentColor"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5v-7Z" /></svg>
                    </span>
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
        <div class="mx-auto max-w-3xl space-y-4 p-5">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="card"><div class="card-body gap-1"><span class="label-caps">CPU</span><span class="text-2xl font-semibold tabular-nums">{{ totals.cpu.toFixed(1) }}%</span><span class="text-xs opacity-55">all services · one core = 100%</span></div></div>
            <div class="card"><div class="card-body gap-1"><span class="label-caps">Memory</span><span class="text-2xl font-semibold tabular-nums">{{ bytes(totals.mem) }}</span><span class="text-xs opacity-55">all services</span></div></div>
            <div class="card"><div class="card-body gap-1"><span class="label-caps">Network</span><span class="text-sm tabular-nums">↓ {{ bytes(totals.rx) }} · ↑ {{ bytes(totals.tx) }}</span><span class="text-xs opacity-55">since each started</span></div></div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Per service</h2>
              <p class="text-xs opacity-55">Live, every 5 seconds; the lines show the last five minutes this page was open.</p>
              <div v-for="c in containers" :key="c.id" class="grid grid-cols-[7rem_1fr_1fr] items-center gap-4 border-t border-base-300/50 py-2">
                <span class="truncate text-sm font-medium">{{ c.service }}</span>
                <div class="flex items-center gap-2">
                  <svg viewBox="0 0 120 28" class="h-7 w-28 shrink-0 text-primary"><path :d="spark((history[c.id] ?? []).map((h) => h.cpu), 5)" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
                  <span class="font-mono text-xs">{{ stats[c.id] ? `${stats[c.id].cpu.toFixed(1)}%` : '—' }}</span>
                </div>
                <div class="flex items-center gap-2">
                  <svg viewBox="0 0 120 28" class="h-7 w-28 shrink-0 text-[var(--c-images)]"><path :d="spark((history[c.id] ?? []).map((h) => h.mem), stats[c.id]?.memLimit ? stats[c.id].memLimit / 8 : 1)" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
                  <span class="font-mono text-xs">{{ stats[c.id] ? bytes(stats[c.id].memUsed) : c.state === 'running' ? '…' : 'stopped' }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <RunPanel v-if="run" :run="run" tall @close="runToken = null" />
    <ConfirmDialog v-if="confirmDown" :title="`Take ${project} down?`" :text="`docker compose down stops and removes ${project}’s containers and networks. Its volumes (your data) stay.`" confirm="Down" tone="error" @cancel="confirmDown = false" @ok="compose('down'); confirmDown = false" />
  </section>
</template>
