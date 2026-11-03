<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { DcMigrateInventory, DcMigrateSource, TaskProgress } from '@shared/types';
import { api, bytes, notify } from '../store';
import TaskSteps from './TaskSteps.vue';

/**
 * Move from another Docker (#11): what the other engine has — tagged images and named volumes, each ticked unless
 * DoCatz has it already — copied onto DoCatz's engine one by one with their progress. The other engine keeps
 * everything, so both can stay side by side.
 */
const props = defineProps<{ source: DcMigrateSource }>();
const emit = defineEmits<{ close: [] }>();

const inv = ref<DcMigrateInventory | null>(null);
const error = ref('');
const images = ref(new Set<string>());
const volumes = ref(new Set<string>());
const task = ref<TaskProgress | null>(null);
const running = computed(() => !!task.value && !task.value.done);
let off: (() => void) | null = null;

onMounted(async () => {
  off = api.onMigrate((t) => (task.value = t));
  try {
    inv.value = await api.migrateInventory(props.source.id);
    images.value = new Set(inv.value.images.filter((i) => !i.inDocatz).map((i) => i.ref));
    volumes.value = new Set(inv.value.volumes.filter((v) => !v.inDocatz).map((v) => v.name));
  } catch (e) {
    error.value = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});
onUnmounted(() => off?.());

const toggle = (set: Set<string>, key: string) => (set.has(key) ? set.delete(key) : set.add(key));
const total = computed(() => {
  if (!inv.value) return 0;
  return inv.value.images.filter((i) => images.value.has(i.ref)).reduce((n, i) => n + i.size, 0) + inv.value.volumes.filter((v) => volumes.value.has(v.name)).reduce((n, v) => n + v.size, 0);
});
const picked = computed(() => images.value.size + volumes.value.size);
const busyVolumes = computed(() => inv.value?.volumes.filter((v) => volumes.value.has(v.name) && v.usedBy > 0).map((v) => v.name) ?? []);

async function move() {
  error.value = '';
  try {
    const failed = await api.migrateRun(props.source.id, [...images.value], [...volumes.value]);
    notify(failed.length ? 'info' : 'success', failed.length ? `Moved, except ${failed.length}` : `Moved ${picked.value} from ${props.source.name}`);
  } catch (e) {
    const m = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (m !== 'Cancelled') error.value = m;
  }
}
function close() {
  if (!running.value) emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="close">
    <div class="modal-box win-fit flex max-h-[calc(100vh-4rem)] w-[40rem] max-w-[95vw] flex-col gap-4">
      <div>
        <h3 class="text-lg font-semibold tracking-tight">Move from {{ source.name }}</h3>
        <p class="text-sm opacity-70">Copies onto DoCatz’s engine. {{ source.name }} keeps everything, so both can stay side by side; each has its own docker context.</p>
      </div>

      <TaskSteps v-if="task" :task="task" class="min-h-0 overflow-y-auto" />
      <template v-else-if="inv">
        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <section>
            <div class="mb-1.5 flex items-center gap-2">
              <span class="label-caps">Images</span><span class="sec-count">{{ inv.images.length }}</span><span class="flex-1" />
              <button v-if="inv.images.length" class="btn btn-ghost btn-xs" @click="images = images.size ? new Set() : new Set(inv.images.filter((i) => !i.inDocatz).map((i) => i.ref))">{{ images.size ? 'None' : 'All' }}</button>
            </div>
            <p v-if="!inv.images.length" class="text-xs opacity-55">No tagged images.</p>
            <ul class="space-y-0.5">
              <li v-for="i in inv.images" :key="i.ref">
                <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-base-200/60">
                  <input type="checkbox" class="checkbox checkbox-sm" :checked="images.has(i.ref)" @change="toggle(images, i.ref)" />
                  <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="i.ref">{{ i.ref }}</span>
                  <span v-if="i.inDocatz" class="badge badge-ghost badge-xs">in DoCatz</span>
                  <span class="shrink-0 text-xs tabular-nums opacity-55">{{ bytes(i.size) }}</span>
                </label>
              </li>
            </ul>
          </section>
          <section>
            <div class="mb-1.5 flex items-center gap-2">
              <span class="label-caps">Volumes</span><span class="sec-count">{{ inv.volumes.length }}</span><span class="flex-1" />
              <button v-if="inv.volumes.length" class="btn btn-ghost btn-xs" @click="volumes = volumes.size ? new Set() : new Set(inv.volumes.filter((v) => !v.inDocatz).map((v) => v.name))">{{ volumes.size ? 'None' : 'All' }}</button>
            </div>
            <p v-if="!inv.volumes.length" class="text-xs opacity-55">No named volumes.</p>
            <ul class="space-y-0.5">
              <li v-for="v in inv.volumes" :key="v.name">
                <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 hover:bg-base-200/60">
                  <input type="checkbox" class="checkbox checkbox-sm" :checked="volumes.has(v.name)" @change="toggle(volumes, v.name)" />
                  <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="v.name">{{ v.name }}</span>
                  <span v-if="v.inDocatz" class="badge badge-warning badge-soft badge-xs" title="A volume of this name is already in DoCatz: its files are added to it">in DoCatz</span>
                  <span v-if="v.usedBy" class="text-[11px] opacity-50">{{ v.usedBy }} container{{ v.usedBy > 1 ? 's' : '' }}</span>
                  <span class="shrink-0 text-xs tabular-nums opacity-55">{{ v.size ? bytes(v.size) : '' }}</span>
                </label>
              </li>
            </ul>
          </section>
        </div>
        <p v-if="busyVolumes.length" class="rounded-lg bg-warning/10 px-3 py-2 text-xs" :title="busyVolumes.join('\n')">
          {{ busyVolumes.length === 1 ? `${busyVolumes[0]} is` : `${busyVolumes.length} of the picked volumes are` }} in use in {{ source.name }}: stop
          {{ busyVolumes.length === 1 ? 'its containers' : 'their containers' }} there first, as a database still writing can be copied half way.
        </p>
      </template>
      <div v-else-if="!error" class="py-6 text-center"><span class="loading loading-dots" /><p class="mt-1 text-xs opacity-55">Looking at {{ source.name }}…</p></div>

      <p v-if="error || (task?.error && !task.cancelled)" class="selectable rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] whitespace-pre-line text-error">{{ error || task?.error }}</p>

      <div class="modal-action mt-0 items-center">
        <span v-if="inv && !task" class="mr-auto text-xs opacity-60">{{ picked }} picked<template v-if="total"> · {{ bytes(total) }}</template></span>
        <button v-if="running" class="btn btn-ghost btn-sm" @click="api.migrateCancel()">Cancel</button>
        <template v-else-if="task?.done">
          <button class="btn btn-primary btn-sm" @click="emit('close')">Done</button>
        </template>
        <template v-else>
          <button class="btn btn-ghost btn-sm" @click="close">Not now</button>
          <button class="btn btn-primary btn-sm" :disabled="!inv || !picked" @click="move">Move {{ picked || '' }}</button>
        </template>
      </div>
    </div>
    <div class="modal-backdrop" @click="close" />
  </dialog>
</template>
