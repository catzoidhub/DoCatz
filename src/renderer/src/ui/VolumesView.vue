<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcVolume } from '@shared/types';
import { api, attempt, bytes, changes, engineUp, errorText, notify } from '../store';
import EngineGate from './EngineGate.vue';
import PruneDialog from './PruneDialog.vue';
import DcNavButtons from './DcNavButtons.vue';
import CatMood from './CatMood.vue';

/** Volumes (DoCatz TODO #14): name, compose project, size, who uses it; remove (typed) and clean up unused. */
const list = ref<DcVolume[]>([]);
const loading = ref(false);
const query = ref('');
async function load() {
  if (!engineUp.value) return;
  // A background reload (an engine event) keeps the list on screen: the spinner is for a first load only.
  loading.value = !list.value.length;
  try {
    list.value = await api.volumes();
  } catch (e) {
    notify('error', errorText(e));
  }
  loading.value = false;
}
watch([engineUp, changes], load, { immediate: true });
const shown = computed(() => list.value.filter((v) => !query.value || v.name.includes(query.value) || (v.project ?? '').includes(query.value)));
const total = computed(() => list.value.reduce((a, v) => a + (v.size ?? 0), 0));

const removing = ref<DcVolume | null>(null);
const typed = ref('');
async function remove() {
  const v = removing.value!;
  removing.value = null;
  typed.value = '';
  await attempt(() => api.volumeRemove(v.name), `${v.name} removed`);
}
const pruning = ref(false);
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <section v-else class="flex h-full flex-col">
    <header class="drag win-top flex h-14 shrink-0 items-end gap-3 border-b border-base-300/60 px-4 pb-2">
      <div class="no-drag"><DcNavButtons /></div>
      <div class="pb-0.5"><h1 class="text-base font-semibold tracking-tight">Volumes</h1><p class="text-xs opacity-55">{{ list.length }} · {{ bytes(total) }}</p></div>
      <span class="flex-1" />
      <button class="no-drag btn btn-sm" @click="pruning = true">Clean up…</button>
    </header>
    <div class="flex shrink-0 items-center gap-2 px-4 py-2">
      <input v-model="query" class="input input-sm w-64" placeholder="Filter" spellcheck="false" />
      <span v-if="loading" class="loading loading-spinner loading-xs" />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-2">
      <table class="table table-sm">
        <thead><tr><th>Volume</th><th class="w-36">Project</th><th class="w-24 text-right">Size</th><th>Used by</th><th class="w-12" /></tr></thead>
        <tbody>
          <tr v-for="v in shown" :key="v.name" class="group">
            <td class="max-w-80 truncate font-mono text-xs" :title="v.name">{{ v.name }}</td>
            <td class="text-xs">{{ v.project ?? '—' }}</td>
            <td class="text-right text-xs tabular-nums">{{ bytes(v.size) }}</td>
            <td class="text-xs"><span v-if="v.containers.length">{{ v.containers.join(', ') }}</span><span v-else class="opacity-45">unused</span></td>
            <td class="text-right"><button class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100" :disabled="v.containers.length > 0" :title="v.containers.length ? 'Remove the containers using it first' : 'Remove'" @click="removing = v">Remove</button></td>
          </tr>
          <tr v-if="!shown.length"><td colspan="5" class="py-8 text-center text-sm opacity-55">No volumes{{ query ? ' match' : '' }}.</td></tr>
        </tbody>
      </table>
    </div>
    <dialog v-if="removing" open class="modal modal-open z-[1000]" @keydown.esc="removing = null">
      <form class="modal-box w-[30rem] max-w-[95vw] space-y-3" @submit.prevent="typed.trim() === removing.name && remove()">
        <div class="flex items-start gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-error/12"><CatMood mood="warning" class="size-8" /></span>
          <div class="min-w-0"><h3 class="text-lg font-semibold tracking-tight">Remove this volume?</h3><p class="text-sm opacity-70">The data inside it is gone for good.</p></div>
        </div>
        <label class="block">
          <span class="label-caps mb-1 block">Type <span class="font-mono normal-case tracking-normal opacity-100">{{ removing.name }}</span> to remove it</span>
          <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="removing.name" spellcheck="false" autocomplete="off" autofocus />
        </label>
        <div class="modal-action"><button type="button" class="btn btn-ghost btn-sm" @click="removing = null">Cancel</button><button class="btn btn-error btn-sm" :disabled="typed.trim() !== removing.name">Remove</button></div>
      </form>
      <div class="modal-backdrop" @click="removing = null" />
    </dialog>
    <PruneDialog v-if="pruning" kind="volumes" @close="pruning = false" @done="load" />
  </section>
</template>
