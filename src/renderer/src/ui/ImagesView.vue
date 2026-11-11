<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcImage, DcImageArchive } from '@shared/types';
import { ago, api, attempt, bytes, changes, engineUp, errorText, notify, runs, token } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import EngineGate from './EngineGate.vue';
import PruneDialog from './PruneDialog.vue';
import RunPanel from './RunPanel.vue';
import DcNavButtons from './DcNavButtons.vue';
import ImageFileDialog from './ImageFileDialog.vue';

/** Images (DoCatz TODO #14): tags, size, age, how many containers use each; pull, remove, clean up unused; export / import (#104). */
const list = ref<DcImage[]>([]);
const loading = ref(false);
const query = ref('');
async function load() {
  if (!engineUp.value) return;
  // A background reload (an engine event) keeps the list on screen: the spinner is for a first load only.
  loading.value = !list.value.length;
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

// export / import (#104): tick images for one archive, or Export… on a row
const picked = ref(new Set<string>());
const toggle = (id: string) => {
  const s = new Set(picked.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  picked.value = s;
};
const allShown = computed(() => shown.value.length > 0 && shown.value.every((i) => picked.value.has(i.id)));
const toggleAll = () => (picked.value = allShown.value ? new Set() : new Set(shown.value.map((i) => i.id)));
watch(list, (l) => (picked.value = new Set([...picked.value].filter((id) => l.some((i) => i.id === id)))));
const exporting = ref<DcImage[] | null>(null);
const importing = ref<DcImageArchive | null>(null);
async function pickArchive() {
  const a = await attempt(() => api.imageImportPick());
  if (a) importing.value = a;
}
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <section v-else class="flex h-full flex-col">
    <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
      <div class="no-drag"><DcNavButtons /></div>
      <div><h1 class="text-base font-semibold tracking-tight">Images</h1><p class="text-xs opacity-55">{{ list.length }} · {{ bytes(total) }}</p></div>
      <span class="flex-1" />
      <form class="no-drag flex items-center gap-1" @submit.prevent="pull">
        <input v-model="pullRef" class="input input-sm w-56 font-mono text-xs" placeholder="postgres:17" spellcheck="false" />
        <button class="btn btn-sm" :disabled="!pullRef.trim()">Pull</button>
      </form>
      <button v-if="picked.size" class="no-drag btn btn-sm" @click="exporting = list.filter((i) => picked.has(i.id))">Export {{ picked.size }}…</button>
      <button class="no-drag btn btn-sm" @click="pickArchive">Import…</button>
      <button class="no-drag btn btn-sm" @click="pruning = true">Clean up…</button>
    </header>
    <div class="flex shrink-0 items-center gap-2 px-4 py-2">
      <input v-model="query" class="input input-sm w-64" placeholder="Filter" spellcheck="false" />
      <span v-if="loading" class="loading loading-spinner loading-xs" />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-2">
      <table class="table table-sm">
        <thead><tr><th class="w-8"><input type="checkbox" class="checkbox checkbox-xs" :checked="allShown" :disabled="!shown.length" title="All shown" @change="toggleAll" /></th><th>Image</th><th class="w-28">ID</th><th class="w-24 text-right">Size</th><th class="w-28 whitespace-nowrap">Created</th><th class="w-32 whitespace-nowrap">In use</th><th class="w-36" /></tr></thead>
        <tbody>
          <tr v-for="i in shown" :key="i.id" class="group">
            <td><input type="checkbox" class="checkbox checkbox-xs" :checked="picked.has(i.id)" @change="toggle(i.id)" /></td>
            <td>
              <div v-for="t in i.tags.length ? i.tags : ['<none>']" :key="t" class="font-mono text-xs" :class="{ 'opacity-50': i.dangling }">{{ t }}</div>
            </td>
            <td class="font-mono text-[11px] opacity-60">{{ i.id.slice(7, 19) }}</td>
            <td class="text-right text-xs tabular-nums">{{ bytes(i.size) }}</td>
            <td class="text-xs opacity-70">{{ ago(i.created) }}</td>
            <td class="text-xs whitespace-nowrap"><span v-if="i.containers" class="badge badge-ghost badge-sm whitespace-nowrap">{{ i.containers }} container{{ i.containers === 1 ? '' : 's' }}</span><span v-else class="opacity-45">unused</span></td>
            <td class="text-right whitespace-nowrap"><button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 focus:opacity-100" @click="exporting = [i]">Export…</button><button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100" @click="removing = i">Remove</button></td>
          </tr>
          <tr v-if="!shown.length"><td colspan="7" class="py-8 text-center text-sm opacity-55">No images{{ query ? ' match' : ' yet — pull one, or run a compose file' }}.</td></tr>
        </tbody>
      </table>
    </div>
    <RunPanel v-if="run" :run="run" @close="pullToken = null" />
    <ConfirmDialog v-if="removing" :title="`Remove ${removing.tags[0] ?? 'this image'}?`" :text="removing.containers ? `${removing.containers} container(s) use it: they must be removed first, or force it (the containers keep running on it until removed).` : 'It downloads again when something needs it.'" :confirm="removing.containers ? 'Force remove' : 'Remove'" tone="error" @cancel="removing = null" @ok="remove(removing!.containers > 0)" />
    <ImageFileDialog v-if="exporting" mode="export" :images="exporting" @close="exporting = null; picked = new Set()" />
    <ImageFileDialog v-if="importing" mode="import" :archive="importing" @close="importing = null" @done="load" />
    <PruneDialog v-if="pruning" kind="images" @close="pruning = false" @done="load" />
  </section>
</template>
