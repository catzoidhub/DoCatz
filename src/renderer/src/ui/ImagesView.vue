<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcImage } from '@shared/types';
import { ago, api, attempt, bytes, changes, engineUp, errorText, notify, runs, token } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import EngineGate from './EngineGate.vue';
import PruneDialog from './PruneDialog.vue';
import RunPanel from './RunPanel.vue';
import DcNavButtons from './DcNavButtons.vue';

/** Images (DoCatz TODO #14): tags, size, age, how many containers use each; pull, remove, clean up unused. */
const list = ref<DcImage[]>([]);
const loading = ref(false);
const query = ref('');
async function load() {
  if (!engineUp.value) return;
  loading.value = true;
  try {
    list.value = await api.images();
  } catch (e) {
    notify('error', errorText(e));
  }
  loading.value = false;
}
watch([engineUp, changes], load, { immediate: true });
const shown = computed(() => list.value.filter((i) => !query.value || i.tags.some((t) => t.toLowerCase().includes(query.value.toLowerCase())) || i.id.includes(query.value)));
const total = computed(() => list.value.reduce((a, i) => a + i.size, 0));

const removing = ref<DcImage | null>(null);
async function remove(force: boolean) {
  const i = removing.value!;
  removing.value = null;
  await attempt(() => api.imageRemove(i.id, force), `${i.tags[0] ?? i.id.slice(7, 19)} removed`);
}
const pruning = ref(false);
const pullRef = ref('');
const pullToken = ref<string | null>(null);
async function pull() {
  const r = pullRef.value.trim();
  if (!r) return;
  pullToken.value = token();
  await attempt(() => api.imagePull(r, pullToken.value!));
  pullRef.value = '';
}
const run = computed(() => (pullToken.value ? runs.value[pullToken.value] : null));
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <section v-else class="flex h-full flex-col">
    <header class="drag win-top flex h-14 shrink-0 items-end gap-3 border-b border-base-300/60 px-4 pb-2">
      <div class="no-drag"><DcNavButtons /></div>
      <div class="pb-0.5"><h1 class="text-base font-semibold tracking-tight">Images</h1><p class="text-xs opacity-55">{{ list.length }} · {{ bytes(total) }}</p></div>
      <span class="flex-1" />
      <form class="no-drag flex items-center gap-1" @submit.prevent="pull">
        <input v-model="pullRef" class="input input-sm w-56 font-mono text-xs" placeholder="postgres:17" spellcheck="false" />
        <button class="btn btn-sm" :disabled="!pullRef.trim()">Pull</button>
      </form>
      <button class="no-drag btn btn-sm" @click="pruning = true">Clean up…</button>
    </header>
    <div class="flex shrink-0 items-center gap-2 px-4 py-2">
      <input v-model="query" class="input input-sm w-64" placeholder="Filter" spellcheck="false" />
      <span v-if="loading" class="loading loading-spinner loading-xs" />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-2">
      <table class="table table-sm">
        <thead><tr><th>Image</th><th class="w-28">ID</th><th class="w-24 text-right">Size</th><th class="w-28 whitespace-nowrap">Created</th><th class="w-32 whitespace-nowrap">In use</th><th class="w-12" /></tr></thead>
        <tbody>
          <tr v-for="i in shown" :key="i.id" class="group">
            <td>
              <div v-for="t in i.tags.length ? i.tags : ['<none>']" :key="t" class="font-mono text-xs" :class="{ 'opacity-50': i.dangling }">{{ t }}</div>
            </td>
            <td class="font-mono text-[11px] opacity-60">{{ i.id.slice(7, 19) }}</td>
            <td class="text-right text-xs tabular-nums">{{ bytes(i.size) }}</td>
            <td class="text-xs opacity-70">{{ ago(i.created) }}</td>
            <td class="text-xs whitespace-nowrap"><span v-if="i.containers" class="badge badge-ghost badge-sm whitespace-nowrap">{{ i.containers }} container{{ i.containers === 1 ? '' : 's' }}</span><span v-else class="opacity-45">unused</span></td>
            <td class="text-right"><button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100" @click="removing = i">Remove</button></td>
          </tr>
          <tr v-if="!shown.length"><td colspan="6" class="py-8 text-center text-sm opacity-55">No images{{ query ? ' match' : ' yet — pull one, or run a compose file' }}.</td></tr>
        </tbody>
      </table>
    </div>
    <RunPanel v-if="run" :run="run" @close="pullToken = null" />
    <ConfirmDialog v-if="removing" :title="`Remove ${removing.tags[0] ?? 'this image'}?`" :text="removing.containers ? `${removing.containers} container(s) use it: they must be removed first, or force it (the containers keep running on it until removed).` : 'It downloads again when something needs it.'" :confirm="removing.containers ? 'Force remove' : 'Remove'" tone="error" @cancel="removing = null" @ok="remove(removing!.containers > 0)" />
    <PruneDialog v-if="pruning" kind="images" @close="pruning = false" @done="load" />
  </section>
</template>
