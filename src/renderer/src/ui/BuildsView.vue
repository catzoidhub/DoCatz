<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcBuild, DcBuildDetail } from '@shared/types';
import { ago, api, attempt, changes, engineUp, errorText, notify } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DcNavButtons from './DcNavButtons.vue';
import EngineGate from './EngineGate.vue';

/**
 * Builds (as OrbStack's): every image build on the DoCatz engine — from a terminal, compose or DevCatz's Build & Up —
 * with its steps, cache use, base images and the full log.
 */
const list = ref<DcBuild[]>([]);
const loading = ref(false);
const query = ref('');
const open = ref<string | null>(null);
const detail = ref<DcBuildDetail | null>(null);
const log = ref('');
const logLoading = ref(false);

async function load() {
  if (!engineUp.value) return;
  // A background reload (an engine event) keeps the list on screen: the spinner is for a first load only.
  loading.value = !list.value.length;
  try {
    list.value = await api.builds();
  } catch (e) {
    notify('error', errorText(e));
  }
  loading.value = false;
}
watch([engineUp, changes], load, { immediate: true });
watch(open, async (ref) => {
  detail.value = null;
  log.value = '';
  if (!ref) return;
  detail.value = (await attempt(() => api.build(ref))) ?? null;
  logLoading.value = true;
  log.value = (await attempt(() => api.buildLogs(ref))) ?? '';
  logLoading.value = false;
});
const shown = computed(() => list.value.filter((b) => !query.value || b.name.toLowerCase().includes(query.value.toLowerCase())));
const dur = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const cached = (b: DcBuild) => (b.steps.total ? Math.round((b.steps.cached / b.steps.total) * 100) : 0);
const STATUS: Record<DcBuild['status'], string> = { completed: 'status-success', failed: 'status-error', cancelled: '', running: 'status-warning' };
/** Log lines: step headers bold, errors red, DONE / CACHED dim. */
const lines = computed(() =>
  log.value.split('\n').map((t) => ({ t, kind: /ERROR|error:|failed to/i.test(t) ? 'err' : /^#\d+ \[/.test(t) ? 'step' : /^#\d+ (DONE|CACHED)/.test(t) ? 'done' : '' })),
);
function copyLog() {
  void navigator.clipboard.writeText(log.value);
  notify('success', 'Build log copied');
}
const removing = ref(false);
async function remove() {
  const r = open.value!;
  removing.value = false;
  if ((await attempt(() => api.buildRemove(r), 'Build removed from the history')) !== undefined) {
    open.value = null;
    await load();
  }
}
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <div v-else class="flex h-full">
    <aside class="flex w-80 shrink-0 flex-col border-r border-base-300/60 bg-base-200/40">
      <div class="drag win-top flex h-20 shrink-0 items-center gap-2 px-3">
        <div class="no-drag"><DcNavButtons /></div>
        <span class="label-caps">Builds</span>
        <span class="sec-count">{{ list.length }}</span>
        <span class="flex-1" />
        <span v-if="loading" class="loading loading-spinner loading-xs mb-2" />
        <button class="no-drag btn btn-ghost btn-xs" @click="load">Refresh</button>
      </div>
      <div class="px-3 pb-2"><input v-model="query" class="input input-sm w-full" placeholder="Filter" spellcheck="false" /></div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <p v-if="!list.length" class="px-3 py-6 text-center text-sm opacity-60">No builds yet. Every <span class="font-mono">docker build</span> and compose build on DoCatz shows up here.</p>
        <button v-for="b in shown" :key="b.ref" class="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors" :class="open === b.ref ? 'bg-primary/15 ring-1 ring-primary/30' : 'hover:bg-base-300/40'" @click="open = b.ref">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-base-300/70 bg-base-100 text-primary">
            <svg viewBox="0 0 20 20" class="size-[18px]" fill="currentColor"><path d="M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Zm0 1.68L5.04 6.65 10 9.13l4.96-2.48L10 4.18ZM4.5 7.86v5.21l4.75 2.37v-5.2L4.5 7.85Zm11 0-4.75 2.38v5.2l4.75-2.37V7.86Z" /></svg>
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5"><span class="status status-xs shrink-0" :class="STATUS[b.status] || 'bg-base-content/30'" /><span class="truncate text-[13px] font-medium">{{ b.name }}</span></span>
            <span class="block truncate text-[11px] opacity-55">{{ ago(b.createdAt) }} · {{ dur(b.durationMs) }} · {{ cached(b) }}% cached</span>
          </span>
        </button>
      </div>
    </aside>

    <section v-if="open" class="flex min-w-0 flex-1 flex-col">
      <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-semibold tracking-tight">{{ detail?.name ?? '…' }}</h1>
          <p v-if="detail" class="truncate text-xs opacity-55">{{ detail.status }} · {{ dur(detail.durationMs) }} · {{ detail.steps.completed }}/{{ detail.steps.total }} steps, {{ detail.steps.cached }} cached</p>
        </div>
        <button v-if="detail?.context" class="no-drag btn btn-ghost btn-sm" :title="detail.context" @click="api.reveal(detail.context)">Show context</button>
        <button class="no-drag btn btn-ghost btn-sm btn-square text-error" title="Remove from the history" @click="removing = true">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.44c-.8.08-1.59.18-2.38.3a.75.75 0 1 0 .23 1.48l.15-.02.84 10.52A2.75 2.75 0 0 0 7.58 19h4.84a2.75 2.75 0 0 0 2.74-2.53l.84-10.52.15.02a.75.75 0 0 0 .23-1.48c-.79-.12-1.58-.22-2.38-.3v-.44A2.75 2.75 0 0 0 11.25 1h-2.5Z" clip-rule="evenodd" /></svg>
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="!detail" class="grid h-40 place-items-center"><span class="loading loading-spinner" /></div>
        <div v-else class="mx-auto max-w-4xl space-y-4 p-5">
          <div v-if="detail.error" role="alert" class="alert alert-error alert-soft selectable text-sm">{{ detail.error }}</div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Build</h2>
              <dl class="selectable grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt class="opacity-60">Context</dt><dd class="font-mono text-xs leading-5 break-all">{{ detail.context || '—' }}</dd>
                <dt class="opacity-60">Dockerfile</dt><dd class="font-mono text-xs leading-5">{{ detail.dockerfile || '—' }}<template v-if="detail.target"> · target {{ detail.target }}</template></dd>
                <template v-if="detail.platforms.length"><dt class="opacity-60">Platforms</dt><dd class="font-mono text-xs leading-5">{{ detail.platforms.join(', ') }}</dd></template>
                <template v-if="detail.bases.length"><dt class="opacity-60">Base images</dt><dd class="font-mono text-xs leading-5 break-all">{{ detail.bases.join(', ') }}</dd></template>
                <template v-if="detail.image"><dt class="opacity-60">Result</dt><dd class="font-mono text-xs leading-5">{{ detail.image.slice(7, 19) }}</dd></template>
                <dt class="opacity-60">Started</dt><dd>{{ new Date(detail.createdAt).toLocaleString() }}</dd>
              </dl>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <div class="flex items-center gap-2"><h2 class="flex-1">Log</h2><span v-if="logLoading" class="loading loading-spinner loading-xs" /><button class="btn btn-ghost btn-xs" :disabled="!log" title="Copy the whole build log" @click="copyLog">Copy</button></div>
              <div class="selectable max-h-[60vh] overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-[11px] leading-snug">
                <div v-for="(l, i) in lines" :key="i" class="whitespace-pre-wrap break-all" :class="{ 'text-error': l.kind === 'err', 'font-semibold text-primary': l.kind === 'step', 'opacity-50': l.kind === 'done' }">{{ l.t || ' ' }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
    <div v-else class="drag grid min-w-0 flex-1 place-items-center p-8 text-center">
      <div class="no-drag max-w-sm space-y-2"><p class="text-base font-semibold tracking-tight">Pick a build</p><p class="text-sm opacity-60">Its steps, cache use, base images and the full log open here.</p></div>
    </div>
    <ConfirmDialog v-if="removing" title="Remove this build from the history?" text="Only the record and its log go; the image it made stays." confirm="Remove" tone="error" @cancel="removing = false" @ok="remove" />
  </div>
</template>
