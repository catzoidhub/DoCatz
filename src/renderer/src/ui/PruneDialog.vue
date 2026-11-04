<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DcPruneKind, DcPrunePreview } from '@shared/types';
import { api, bytes, errorText, notify } from '../store';
import CatMood from './CatMood.vue';
import CopyName from './CopyName.vue';

/** Clean up with a preview (DoCatz TODO #14): exactly what goes is listed first, then one click removes it. */
const props = defineProps<{ kind: DcPruneKind }>();
const emit = defineEmits<{ close: []; done: [] }>();
const WHAT: Record<DcPruneKind, { title: string; none: string; note: string }> = {
  containers: { title: 'Remove stopped containers', none: 'No stopped containers.', note: 'Their images and named volumes stay.' },
  images: { title: 'Remove unused images', none: 'Every image is used by a container.', note: 'Images no container uses (running or stopped). They download again when needed.' },
  volumes: { title: 'Remove unused volumes', none: 'Every volume is used by a container.', note: 'Volumes no container uses — the data inside them is gone for good.' },
  networks: { title: 'Remove unused networks', none: 'No unused networks.', note: 'Networks you made that no container is on. Docker’s own stay.' },
  'build-cache': { title: 'Clear the build cache', none: 'The build cache is empty.', note: 'The next builds take longer once.' },
};
const w = computed(() => WHAT[props.kind]);
const preview = ref<DcPrunePreview | null>(null);
const busy = ref(false);
const typed = ref('');
const needsWord = computed(() => props.kind === 'volumes');
onMounted(async () => {
  try {
    preview.value = await api.prunePreview(props.kind);
  } catch (e) {
    notify('error', errorText(e));
    emit('close');
  }
});
async function go() {
  busy.value = true;
  try {
    const r = await api.prune(props.kind);
    notify('success', `${r.removed} removed${r.freed ? `, ${bytes(r.freed)} freed` : ''}`);
    emit('done');
    emit('close');
  } catch (e) {
    notify('error', errorText(e));
  }
  busy.value = false;
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('close')">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-error/12"><CatMood mood="warning" class="size-8" /></span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">{{ w.title }}</h3>
          <p class="text-sm opacity-65">{{ w.note }}</p>
        </div>
      </div>
      <div v-if="!preview" class="grid h-24 place-items-center"><span class="loading loading-spinner" /></div>
      <template v-else>
        <p v-if="!preview.items.length" class="text-sm opacity-70">{{ w.none }}</p>
        <div v-else class="space-y-1">
          <p class="label-caps">{{ preview.items.length }} to remove<template v-if="preview.total"> · {{ bytes(preview.total) }}</template></p>
          <ul class="selectable max-h-60 overflow-y-auto rounded-lg border border-base-300/70 bg-base-200/40 p-2 font-mono text-xs">
            <li v-for="i in preview.items" :key="i.id" class="flex gap-2 py-0.5"><span class="min-w-0 flex-1 truncate">{{ i.name }}</span><span v-if="i.size !== null" class="opacity-50">{{ bytes(i.size) }}</span></li>
          </ul>
        </div>
        <label v-if="needsWord && preview.items.length" class="block">
          <span class="label-caps mb-1 block">Type <CopyName value="delete" /> to remove the data</span>
          <input v-model="typed" class="input input-sm w-full font-mono" placeholder="delete" spellcheck="false" autocomplete="off" />
        </label>
      </template>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="busy || !preview?.items.length || (needsWord && typed.trim() !== 'delete')" @click="go"><span v-if="busy" class="loading loading-spinner loading-xs" />Remove {{ preview?.items.length ?? '' }}</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
