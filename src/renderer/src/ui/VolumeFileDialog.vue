<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { DcVolume, DcVolumeArchive, TaskProgress } from '@shared/types';
import { api, bytes, errorText, notify } from '../store';
import TaskSteps from './TaskSteps.vue';
import CopyName from './CopyName.vue';

/**
 * A volume to a file and back (#102). Export: the volume's files as .tar.gz with a manifest beside it (DoCatz asks
 * where). Import: an archive picked before this opens, into a new volume (the manifest's name, editable) or — when
 * the name is taken and the user says so — in place of an existing volume's files, after typing its name.
 */
const props = defineProps<{ mode: 'export'; volume: DcVolume } | { mode: 'import'; archive: DcVolumeArchive }>();
const emit = defineEmits<{ close: []; done: [] }>();

const task = ref<TaskProgress | null>(null);
const running = computed(() => !!task.value && !task.value.done);
const error = ref('');
const saved = ref<string | null>(null);
const writers = ref<string[]>([]);
let off: (() => void) | null = null;

onMounted(async () => {
  off = api.onVolume((t) => (task.value = t));
  if (props.mode === 'export') writers.value = await api.volumeWriters(props.volume.name).catch(() => []);
});
onUnmounted(() => off?.());

// import
const name = ref(props.mode === 'import' ? props.archive.name : '');
const replace = ref(false);
const typed = ref('');
const taken = computed(() => props.mode === 'import' && props.archive.taken.includes(name.value.trim()));
const validName = computed(() => /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name.value.trim()));
const canImport = computed(() => validName.value && (!taken.value || (replace.value && typed.value.trim() === name.value.trim())));

async function go() {
  error.value = '';
  try {
    if (props.mode === 'export') {
      saved.value = await api.volumeExport(props.volume.name);
      if (saved.value) notify('success', `${props.volume.name} exported`);
      else task.value = null;
    } else {
      const n = name.value.trim();
      await api.volumeImport(props.archive.file, n, taken.value, taken.value ? typed.value.trim() : undefined);
      notify('success', `${n} imported`);
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
const manifest = computed(() => (props.mode === 'import' ? props.archive.manifest : null));
const project = computed(() => manifest.value?.labels['com.docker.compose.project'] ?? null);
</script>

<template>
  <dialog open class="modal modal-open z-[1000]" @keydown.esc="close">
    <form class="modal-box win-fit flex w-[34rem] max-w-[95vw] flex-col gap-4" @submit.prevent="!task && (mode === 'export' || canImport) && go()">
      <div>
        <h3 class="text-lg font-semibold tracking-tight">{{ mode === 'export' ? `Export ${volume.name}` : 'Import a volume' }}</h3>
        <p v-if="mode === 'export'" class="text-sm opacity-70">Saves its files as a .tar.gz, with a small manifest beside it (name and labels), to back it up or bring it to another computer.</p>
        <p v-else class="text-sm opacity-70">From <span class="font-mono text-[13px]">{{ archive.fileName }}</span> · {{ bytes(archive.size) }}</p>
      </div>

      <TaskSteps v-if="task" :task="task" />
      <template v-else-if="mode === 'export'">
        <dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="opacity-60">Project</dt><dd>{{ volume.project ?? '—' }}</dd>
          <dt class="opacity-60">Size</dt><dd>{{ volume.size ? bytes(volume.size) : '—' }}</dd>
        </dl>
        <p v-if="writers.length" class="rounded-lg bg-warning/10 px-3 py-2 text-xs">
          {{ writers.join(', ') }} {{ writers.length === 1 ? 'is' : 'are' }} running with it. A database still writing can be copied half way: stop {{ writers.length === 1 ? 'it' : 'them' }} first for a clean copy.
        </p>
      </template>
      <template v-else>
        <dl v-if="manifest" class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="opacity-60">Volume</dt><dd class="font-mono text-[13px]">{{ manifest.name }}</dd>
          <dt v-if="project" class="opacity-60">Project</dt><dd v-if="project">{{ project }}</dd>
          <dt class="opacity-60">Exported</dt><dd>{{ new Date(manifest.exported).toLocaleString() }} · DoCatz {{ manifest.docatz }}</dd>
        </dl>
        <p v-else class="text-xs opacity-60">No manifest beside it: a plain archive. Its files go into the volume as they are.</p>
        <label class="block">
          <span class="label-caps mb-1 block">Volume name</span>
          <input v-model="name" class="input input-sm w-full font-mono" spellcheck="false" autocomplete="off" @input="replace = false; typed = ''" />
          <span v-if="!validName" class="mt-1 block text-xs text-error">Letters, digits, _ . - and starting with a letter or digit.</span>
          <span v-else-if="manifest && name.trim() !== manifest.name" class="mt-1 block text-xs opacity-60">A new name: its compose project will not find it as its own.</span>
        </label>
        <div v-if="taken" class="space-y-2 rounded-lg bg-warning/10 px-3 py-2 text-sm">
          <p>A volume named <span class="font-mono">{{ name.trim() }}</span> is already here. Pick another name, or replace its files.</p>
          <label class="flex cursor-pointer items-center gap-2"><input v-model="replace" type="checkbox" class="checkbox checkbox-sm" />Replace its files with the archive’s</label>
          <label v-if="replace" class="block">
            <span class="label-caps mb-1 block">Its files now are gone for good. Type <CopyName :value="name.trim()" /> to replace them</span>
            <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="name.trim()" spellcheck="false" autocomplete="off" />
          </label>
        </div>
      </template>

      <p v-if="saved" class="text-sm">Saved as <span class="font-mono text-[13px]">{{ saved }}</span>, with its manifest beside it.</p>
      <p v-if="error || (task?.error && !task.cancelled)" class="selectable rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] whitespace-pre-line text-error">{{ error || task?.error }}</p>

      <div class="modal-action mt-0">
        <button v-if="running" type="button" class="btn btn-ghost btn-sm" @click="api.volumeCancel()">Cancel</button>
        <button v-else-if="task?.done" type="button" class="btn btn-primary btn-sm" @click="emit('close')">Done</button>
        <template v-else>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Cancel</button>
          <button v-if="mode === 'export'" class="btn btn-primary btn-sm">Export…</button>
          <button v-else class="btn btn-sm" :class="taken ? 'btn-error' : 'btn-primary'" :disabled="!canImport">{{ taken ? 'Replace' : 'Import' }}</button>
        </template>
      </div>
    </form>
    <div class="modal-backdrop" @click="close" />
  </dialog>
</template>
