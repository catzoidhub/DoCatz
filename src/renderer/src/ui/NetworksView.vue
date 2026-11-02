<script setup lang="ts">
import { ref, watch } from 'vue';
import type { DcNetwork } from '@shared/types';
import { api, attempt, changes, engineUp, errorText, notify } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import EngineGate from './EngineGate.vue';
import PruneDialog from './PruneDialog.vue';
import DcNavButtons from './DcNavButtons.vue';

/** Networks (DoCatz TODO #14): driver, subnet, project, containers on it; remove and clean up unused (Docker's own stay). */
const list = ref<DcNetwork[]>([]);
const loading = ref(false);
async function load() {
  if (!engineUp.value) return;
  // A background reload (an engine event) keeps the list on screen: the spinner is for a first load only.
  loading.value = !list.value.length;
  try {
    list.value = await api.networks();
  } catch (e) {
    notify('error', errorText(e));
  }
  loading.value = false;
}
watch([engineUp, changes], load, { immediate: true });
const removing = ref<DcNetwork | null>(null);
async function remove() {
  const n = removing.value!;
  removing.value = null;
  await attempt(() => api.networkRemove(n.id), `${n.name} removed`);
}
const pruning = ref(false);
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <section v-else class="flex h-full flex-col">
    <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
      <div class="no-drag"><DcNavButtons /></div>
      <div><h1 class="text-base font-semibold tracking-tight">Networks</h1><p class="text-xs opacity-55">{{ list.length }}</p></div>
      <span class="flex-1" />
      <span v-if="loading" class="loading loading-spinner loading-xs mb-2" />
      <button class="no-drag btn btn-sm" @click="pruning = true">Clean up…</button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pt-2">
      <table class="table table-sm">
        <thead><tr><th>Network</th><th class="w-24">Driver</th><th class="w-40">Subnet</th><th class="w-32">Project</th><th>Containers</th><th class="w-12" /></tr></thead>
        <tbody>
          <tr v-for="n in list" :key="n.id" class="group">
            <td class="font-mono text-xs">{{ n.name }} <span v-if="n.builtin" class="badge badge-ghost badge-xs">Docker’s own</span><span v-if="n.internal" class="badge badge-ghost badge-xs">internal</span></td>
            <td class="text-xs">{{ n.driver }}</td>
            <td class="font-mono text-[11px] opacity-70">{{ n.subnet || '—' }}</td>
            <td class="text-xs">{{ n.project ?? '—' }}</td>
            <td class="text-xs"><span v-if="n.containers.length">{{ n.containers.join(', ') }}</span><span v-else class="opacity-45">none</span></td>
            <td class="text-right"><button v-if="!n.builtin" class="btn btn-ghost btn-xs text-error opacity-0 group-hover:opacity-100" :disabled="n.containers.length > 0" @click="removing = n">Remove</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <ConfirmDialog v-if="removing" :title="`Remove ${removing.name}?`" text="No container is on it." confirm="Remove" tone="error" @cancel="removing = null" @ok="remove" />
    <PruneDialog v-if="pruning" kind="networks" @close="pruning = false" @done="load" />
  </section>
</template>
