<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DcContainer } from '@shared/types';
import { bytes, containers, containerTab, engine, engineUp, liveStats, openContainer, openProject, projectTab, section, statsHistory } from '../store';
import DcNavButtons from './DcNavButtons.vue';
import EngineGate from './EngineGate.vue';
import ServiceMark from './ServiceMark.vue';
import TimeChart, { type Series } from './TimeChart.vue';

/**
 * Monitoring (as OrbStack's activity monitor): what the engine uses right now and over the last 10 minutes — CPU and
 * memory of the VM's Docker, per compose project and per container — and a table to find what is busy.
 */
type SortKey = 'cpu' | 'mem' | 'net' | 'name';
const sort = ref<SortKey>('cpu');
const groupBy = ref<'container' | 'project'>('container');

const running = computed(() => containers.value.filter((c) => c.state === 'running'));
const total = computed(() => {
  const list = running.value.map((c) => liveStats.value[c.id]).filter(Boolean);
  return { cpu: list.reduce((a, s) => a + s.cpu, 0), mem: list.reduce((a, s) => a + s.memUsed, 0) };
});
const vmCpus = computed(() => engine.value?.docker?.cpus ?? engine.value?.config.cpus ?? 1);
const vmMem = computed(() => engine.value?.docker?.memory ?? (engine.value?.config.memoryGiB ?? 1) * 1024 ** 3);
const cpuShare = computed(() => Math.min(100, total.value.cpu / vmCpus.value));
const memShare = computed(() => Math.min(100, (total.value.mem / vmMem.value) * 100));

/** Sums over time: every container's samples added up per 5-second slot. */
function summed(key: 'cpu' | 'mem', ids: string[]): { t: number; v: number }[] {
  const slots = new Map<number, number>();
  for (const id of ids) for (const h of statsHistory.value[id] ?? []) {
    const t = Math.round(h.t / 5000) * 5000;
    slots.set(t, (slots.get(t) ?? 0) + h[key]);
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}
const PALETTE = ['oklch(70% 0.14 240)', 'oklch(70% 0.16 330)', 'oklch(74% 0.15 78)', 'oklch(70% 0.13 180)', 'oklch(64% 0.17 280)', 'oklch(68% 0.16 28)', 'oklch(70% 0.15 150)'];
/** One line per compose project (and one for containers of their own), so the chart stays readable. */
const groups = computed(() => {
  const m = new Map<string, DcContainer[]>();
  for (const c of running.value) m.set(c.project ?? 'Other containers', [...(m.get(c.project ?? 'Other containers') ?? []), c]);
  return [...m.entries()];
});
const cpuSeries = computed<Series[]>(() => groups.value.map(([name, list], i) => ({ name, color: PALETTE[i % PALETTE.length], points: summed('cpu', list.map((c) => c.id)) })));
const memSeries = computed<Series[]>(() => groups.value.map(([name, list], i) => ({ name, color: PALETTE[i % PALETTE.length], points: summed('mem', list.map((c) => c.id)) })));

/** Rows of the table: one per container, or one per project. */
const rows = computed(() => {
  const per = running.value.map((c) => {
    const s = liveStats.value[c.id];
    return { key: c.id, name: c.project && c.service ? c.service : c.name, project: c.project, container: c as DcContainer | null, cpu: s?.cpu ?? 0, mem: s?.memUsed ?? 0, net: (s?.netRx ?? 0) + (s?.netTx ?? 0), pids: s?.pids ?? 0, count: 1 };
  });
  let list = per;
  if (groupBy.value === 'project') {
    const m = new Map<string, (typeof per)[number]>();
    for (const r of per) {
      const k = r.project ?? r.name;
      const g = m.get(k) ?? { key: k, name: k, project: r.project, container: null, cpu: 0, mem: 0, net: 0, pids: 0, count: 0 };
      g.cpu += r.cpu;
      g.mem += r.mem;
      g.net += r.net;
      g.pids += r.pids;
      g.count += 1;
      m.set(k, g);
    }
    list = [...m.values()];
  }
  const by = sort.value;
  return [...list].sort((a, b) => (by === 'name' ? a.name.localeCompare(b.name) : b[by] - a[by]));
});
const maxCpu = computed(() => Math.max(1, ...rows.value.map((r) => r.cpu)));
const maxMem = computed(() => Math.max(1, ...rows.value.map((r) => r.mem)));

function open(r: (typeof rows.value)[number]) {
  section.value = 'containers';
  if (r.container) {
    openProject.value = null;
    openContainer.value = r.container.name;
    containerTab.value = 'stats';
  } else if (r.project) {
    openContainer.value = null;
    openProject.value = r.project;
    projectTab.value = 'monitoring';
  }
}
const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <section v-else class="flex h-full flex-col">
    <header class="drag win-top flex h-14 shrink-0 items-end gap-3 border-b border-base-300/60 px-4 pb-2">
      <div class="no-drag"><DcNavButtons /></div>
      <div class="pb-0.5"><h1 class="text-base font-semibold tracking-tight">Monitoring</h1><p class="text-xs opacity-55">{{ running.length }} running · every 5 seconds</p></div>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-5xl space-y-4 p-5">
        <!-- the engine now -->
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="card">
            <div class="card-body gap-2">
              <span class="label-caps">CPU</span>
              <div class="flex items-baseline gap-2"><span class="text-2xl font-semibold tabular-nums">{{ pct(total.cpu) }}</span><span class="text-xs opacity-55">of {{ vmCpus * 100 }}% ({{ vmCpus }} CPUs)</span></div>
              <div class="h-1.5 overflow-hidden rounded-full bg-base-300/60"><div class="h-full rounded-full bg-primary transition-[width]" :style="{ width: `${cpuShare}%` }" /></div>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <span class="label-caps">Memory</span>
              <div class="flex items-baseline gap-2"><span class="text-2xl font-semibold tabular-nums">{{ bytes(total.mem) }}</span><span class="text-xs opacity-55">of {{ bytes(vmMem) }}</span></div>
              <div class="h-1.5 overflow-hidden rounded-full bg-base-300/60"><div class="h-full rounded-full bg-[var(--c-images)] transition-[width]" :style="{ width: `${memShare}%` }" /></div>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <span class="label-caps">Engine</span>
              <div class="flex items-baseline gap-2"><span class="text-2xl font-semibold tabular-nums">{{ running.length }}</span><span class="text-xs opacity-55">running of {{ containers.length }} containers</span></div>
              <span class="text-xs opacity-55">{{ engine?.docker ? `Docker ${engine.docker.version} · ${engine.vm?.manager}` : '' }}</span>
            </div>
          </div>
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <div class="card"><div class="card-body gap-2"><div class="flex items-baseline gap-2"><h2 class="flex-1">CPU</h2><span class="text-xs opacity-50">per project, 10 minutes</span></div><TimeChart :series="cpuSeries" :format="pct" :min-max="5" :height="170" /></div></div>
          <div class="card"><div class="card-body gap-2"><div class="flex items-baseline gap-2"><h2 class="flex-1">Memory</h2><span class="text-xs opacity-50">per project, 10 minutes</span></div><TimeChart :series="memSeries" :format="bytes" :min-max="128 * 1024 * 1024" :height="170" /></div></div>
        </div>

        <!-- what is busy -->
        <div class="card">
          <div class="card-body gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="flex-1">Processes</h2>
              <div role="tablist" class="seg seg-xs">
                <a role="tab" class="seg-item" :class="{ 'is-active': groupBy === 'container' }" @click="groupBy = 'container'">Containers</a>
                <a role="tab" class="seg-item" :class="{ 'is-active': groupBy === 'project' }" @click="groupBy = 'project'">Projects</a>
              </div>
            </div>
            <table class="table table-sm">
              <thead>
                <tr>
                  <th class="cursor-pointer" @click="sort = 'name'">Name<span v-if="sort === 'name'"> ↓</span></th>
                  <th class="w-48 cursor-pointer" @click="sort = 'cpu'">CPU<span v-if="sort === 'cpu'"> ↓</span></th>
                  <th class="w-48 cursor-pointer" @click="sort = 'mem'">Memory<span v-if="sort === 'mem'"> ↓</span></th>
                  <th class="w-28 cursor-pointer text-right" @click="sort = 'net'">Network<span v-if="sort === 'net'"> ↓</span></th>
                  <th class="w-16 text-right">{{ groupBy === 'project' ? 'Services' : 'PIDs' }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rows" :key="r.key" class="cursor-pointer hover:bg-base-200/60" @click="open(r)">
                  <td>
                    <div class="flex min-w-0 items-center gap-2.5">
                      <ServiceMark v-if="r.container" :container="r.container" size="sm" />
                      <span v-else class="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary"><svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M3.196 12.87l-.825.483a.75.75 0 0 0 0 1.294l7.25 4.25a.75.75 0 0 0 .758 0l7.25-4.25a.75.75 0 0 0 0-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 0 1-2.276 0L3.196 12.87ZM10.38 1.103a.75.75 0 0 0-.76 0l-7.25 4.25a.75.75 0 0 0 0 1.294l7.25 4.25a.75.75 0 0 0 .76 0l7.25-4.25a.75.75 0 0 0 0-1.294l-7.25-4.25Z" /></svg></span>
                      <span class="min-w-0">
                        <span class="block truncate font-medium">{{ r.name }}</span>
                        <span v-if="r.container && r.project" class="block truncate text-[11px] opacity-50">{{ r.project }}</span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <div class="flex items-center gap-2"><div class="h-1.5 flex-1 overflow-hidden rounded-full bg-base-300/60"><div class="h-full rounded-full bg-primary" :style="{ width: `${(r.cpu / maxCpu) * 100}%` }" /></div><span class="w-12 text-right font-mono text-xs">{{ pct(r.cpu) }}</span></div>
                  </td>
                  <td>
                    <div class="flex items-center gap-2"><div class="h-1.5 flex-1 overflow-hidden rounded-full bg-base-300/60"><div class="h-full rounded-full bg-[var(--c-images)]" :style="{ width: `${(r.mem / maxMem) * 100}%` }" /></div><span class="w-16 text-right font-mono text-xs">{{ bytes(r.mem) }}</span></div>
                  </td>
                  <td class="text-right font-mono text-xs opacity-70">{{ bytes(r.net) }}</td>
                  <td class="text-right font-mono text-xs opacity-70">{{ groupBy === 'project' ? r.count : r.pids }}</td>
                </tr>
                <tr v-if="!rows.length"><td colspan="5" class="py-8 text-center text-sm opacity-55">Nothing is running.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
