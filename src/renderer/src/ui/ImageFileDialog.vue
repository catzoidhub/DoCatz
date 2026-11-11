<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { DcImage, DcImageArchive, TaskProgress } from '@shared/types';
import { api, bytes, errorText, notify } from '../store';
import TaskSteps from './TaskSteps.vue';

/**
 * Images to a file and back (#104): export = `docker save` of the picked images as one .tar.gz (DoCatz asks where);
 * import = `docker load` of an archive picked before this opens. An image with the same tag gets the archive's.
 */
const props = defineProps<{ mode: 'export'; images: DcImage[] } | { mode: 'import'; archive: DcImageArchive }>();
const emit = defineEmits<{ close: []; done: [] }>();

const task = ref<TaskProgress | null>(null);
const running = computed(() => !!task.value && !task.value.done);
const error = ref('');
const saved = ref<string | null>(null);
const loaded = ref<string[] | null>(null);
let off: (() => void) | null = null;
onMounted(() => (off = api.onFileJob((t) => (task.value = t))));
onUnmounted(() => off?.());

/** What `docker save` is given: the first tag, or the id for an untagged image. */
const refs = computed(() => (props.mode === 'export' ? props.images.map((i) => i.tags[0] ?? i.id) : []));
const size = computed(() => (props.mode === 'export' ? props.images.reduce((n, i) => n + i.size, 0) : 0));

async function go() {
  error.value = '';
  try {
    if (props.mode === 'export') {
      saved.value = await api.imageExport(refs.value);
      if (saved.value) notify('success', refs.value.length === 1 ? `${refs.value[0]} exported` : `${refs.value.length} images exported`);
      else task.value = null;
    } else {
      loaded.value = await api.imageImport(props.archive.file);
      notify('success', loaded.value.length === 1 ? `${loaded.value[0]} imported` : `${loaded.value.length} images imported`);
      emit('done');
    }
  } catch (e) {
    const m = errorText(e);
    if (m !== 'Cancelled') error.value = m;
  }
}
function close() {
  if (!running.value) emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open z-[1000]" @keydown.esc="close">
    <form class="modal-box win-fit flex w-[34rem] max-w-[95vw] flex-col gap-4" @submit.prevent="!task && go()">
      <div>
        <h3 class="text-lg font-semibold tracking-tight">{{ mode === 'export' ? (refs.length === 1 ? `Export ${refs[0]}` : `Export ${refs.length} images`) : 'Import images' }}</h3>
        <p v-if="mode === 'export'" class="text-sm opacity-70">Saves {{ refs.length === 1 ? 'it' : 'them' }} as one .tar.gz, to bring to another computer or keep before an update. Import it there, or <span class="font-mono text-[13px]">docker load -i</span>.</p>
        <p v-else class="text-sm opacity-70">From <span class="font-mono text-[13px]">{{ archive.fileName }}</span> · {{ bytes(archive.size) }}</p>
      </div>

      <TaskSteps v-if="task" :task="task" />
      <template v-else-if="mode === 'export'">
        <ul class="max-h-40 space-y-0.5 overflow-y-auto font-mono text-xs">
          <li v-for="i in images" :key="i.id" class="flex gap-2"><span class="min-w-0 flex-1 truncate">{{ i.tags[0] ?? i.id.slice(7, 19) }}</span><span class="opacity-55">{{ bytes(i.size) }}</span></li>
        </ul>
        <p class="text-xs opacity-60">{{ bytes(size) }} before compressing.</p>
      </template>
      <p v-else class="text-sm opacity-70">An image already here with the same tag gets the archive’s in its place; the old one stays, untagged, until cleaned up.</p>

      <p v-if="saved" class="text-sm">Saved as <span class="font-mono text-[13px]">{{ saved }}</span>.</p>
      <div v-if="loaded" class="text-sm">
        <p>Imported:</p>
        <ul class="mt-1 max-h-32 overflow-y-auto font-mono text-xs"><li v-for="r in loaded" :key="r">{{ r }}</li></ul>
      </div>
      <p v-if="error || (task?.error && !task.cancelled)" class="selectable rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] whitespace-pre-line text-error">{{ error || task?.error }}</p>

      <div class="modal-action mt-0">
        <button v-if="running" type="button" class="btn btn-ghost btn-sm" @click="api.volumeCancel()">Cancel</button>
        <button v-else-if="task?.done" type="button" class="btn btn-primary btn-sm" @click="emit('close')">Done</button>
        <template v-else>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Cancel</button>
          <button class="btn btn-primary btn-sm">{{ mode === 'export' ? 'Export…' : 'Import' }}</button>
        </template>
      </div>
    </form>
    <div class="modal-backdrop" @click="close" />
  </dialog>
</template>
