<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { DcAiPreview, DcComposeAction, DcFileAnswer } from '@shared/types';
import { aiOn, api, attempt, composeFile, engineUp, errorText, notify, runs, token } from '../store';
import RunPanel from './RunPanel.vue';
import CodeEditor from './CodeEditor.vue';
import CatMood from './CatMood.vue';
import { keyLabel } from '@shared/platform';

/**
 * A compose file (DoCatz TODO #17): open it (File → Open Compose File…, or a docatz://compose link — which only opens
 * it here, never runs it), edit it in a code editor (YAML colours, line numbers, Find & Replace) and save it — the
 * project's own file — then Up / Restart / Stop / Down / Pull / Build with the output below; a run saves first, so it
 * always uses what the editor shows. Closing with unsaved changes asks first.
 * With AI on, "Write with AI" drafts or fixes the file (TODO #20); the draft is shown next to the file and only
 * replaces it on "Use this".
 */
const emit = defineEmits<{ close: [] }>();
const file = ref<string | null>(composeFile.value);
const text = ref('');
const saved = ref('');
const dirty = computed(() => text.value !== saved.value);
const runToken = ref<string | null>(null);
const run = computed(() => (runToken.value ? runs.value[runToken.value] : null));
const editor = ref<InstanceType<typeof CodeEditor> | null>(null);
/** Closing with changes not saved: Save, Discard or keep editing. */
const leaving = ref(false);
function close() {
  if (dirty.value) leaving.value = true;
  else emit('close');
}
function onEsc(e: KeyboardEvent) {
  // Escape first closes the editor's Find & Replace (CodeMirror handled it: defaultPrevented), then the dialog
  if (e.defaultPrevented || editor.value?.searching()) return;
  close();
}
async function saveAndClose() {
  await save();
  if (!dirty.value) emit('close');
}

async function load(path: string) {
  try {
    text.value = saved.value = await api.readText(path);
    file.value = path;
  } catch (e) {
    notify('error', errorText(e));
  }
}
async function pick() {
  const p = await attempt(() => api.composePick());
  if (p) await load(p);
}
onMounted(() => (file.value ? load(file.value) : pick()));

async function save() {
  if (!file.value) return;
  if ((await attempt(() => api.writeText(file.value!, text.value), 'Saved')) !== undefined) saved.value = text.value;
}
async function act(action: DcComposeAction) {
  if (!file.value) return;
  if (dirty.value) await save();
  runToken.value = token();
  await attempt(() => api.composeRun(file.value!, action, runToken.value!));
}

// ---- Write / fix with AI
const aiAllowed = aiOn('compose');
const prompt = ref('');
const asking = ref(false);
const draft = ref<DcFileAnswer | null>(null);
const preview = ref<DcAiPreview | null>(null);
let aiToken = '';
const request = () => ({ kind: 'compose' as const, current: text.value, prompt: prompt.value, error: run.value?.error ? run.value.lines.slice(-40).join('\n') : undefined });
async function ask() {
  asking.value = true;
  draft.value = null;
  aiToken = token();
  try {
    draft.value = await api.aiFile(request(), aiToken);
  } catch (e) {
    if (errorText(e) !== 'Stopped') notify('error', errorText(e));
  }
  asking.value = false;
}
async function showPreview() {
  preview.value = (await attempt(() => api.aiPreviewFile(request()))) ?? null;
}
function useDraft() {
  if (draft.value) text.value = draft.value.file;
  draft.value = null;
}
const name = computed(() => file.value?.split(/[\\/]/).slice(-2).join('/') ?? '');
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="onEsc">
    <div class="modal-box flex h-[86vh] w-[64rem] max-w-[96vw] flex-col gap-3 p-0">
      <div class="flex items-center gap-2 border-b border-base-300/60 px-5 py-3">
        <h3 class="text-base font-semibold tracking-tight">Compose</h3>
        <button v-if="file" class="btn btn-ghost btn-xs font-mono" :title="file" @click="api.reveal(file)">{{ name }}</button>
        <span v-if="dirty" class="badge badge-warning badge-soft badge-sm">not saved</span>
        <span class="flex-1" />
        <button v-if="file" class="btn btn-ghost btn-sm gap-1.5" :title="`Find & Replace (${keyLabel('mod+F')})`" @click="editor?.find()">
          <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.45 4.39l3.08 3.08a.75.75 0 1 1-1.06 1.06l-3.08-3.08A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>Find &amp; Replace
        </button>
        <button class="btn btn-ghost btn-sm" @click="pick">Open…</button>
        <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" @click="close">✕</button>
      </div>

      <div v-if="!file" class="grid flex-1 place-items-center p-8 text-center">
        <div class="space-y-3">
          <p class="text-sm opacity-60">Pick a docker-compose.yml or compose.yaml.</p>
          <button class="btn btn-primary btn-sm" @click="pick">Open a compose file…</button>
        </div>
      </div>
      <template v-else>
        <div class="flex min-h-0 flex-1 gap-3 px-5">
          <div class="min-h-0 min-w-0 flex-1"><CodeEditor ref="editor" v-model="text" @save="save" /></div>
          <aside v-if="aiAllowed && (asking || draft)" class="flex w-[26rem] shrink-0 flex-col gap-2">
            <div class="flex items-center gap-2"><span class="label-caps flex-1">AI draft</span><button v-if="asking" class="btn btn-ghost btn-xs" @click="api.aiCancel(aiToken)">Stop</button></div>
            <p v-if="asking" class="text-sm opacity-60">Writing…</p>
            <template v-if="draft">
              <p class="text-sm opacity-80">{{ draft.explanation }}</p>
              <pre class="selectable min-h-0 flex-1 overflow-auto rounded-lg bg-base-200/70 p-2 font-mono text-[11px] whitespace-pre-wrap">{{ draft.file }}</pre>
              <div class="flex gap-2"><button class="btn btn-primary btn-sm" @click="useDraft">Use this</button><button class="btn btn-ghost btn-sm" @click="draft = null">Discard</button></div>
            </template>
          </aside>
        </div>
        <form v-if="aiAllowed" class="flex items-center gap-2 px-5" @submit.prevent="ask">
          <input v-model="prompt" class="input input-sm min-w-0 flex-1" :placeholder="run?.error ? 'Fix the error above (or say what to change)' : 'Write with AI: “add a postgres service with a volume”'" />
          <a class="link text-xs opacity-60" @click="showPreview">Preview what is sent</a>
          <button class="btn btn-sm" :disabled="asking || (!prompt.trim() && !run?.error)">✦ {{ run?.error && !prompt.trim() ? 'Fix with AI' : 'Write with AI' }}</button>
        </form>
        <div class="flex items-center gap-1 px-5">
          <button class="btn btn-sm" :disabled="!dirty" :title="`Save to the project's file (${keyLabel('mod+S')})`" @click="save">Save</button>
          <span class="ml-2 text-xs opacity-50">{{ dirty ? 'Up, Build and the rest save it first.' : 'Saved in the project’s folder.' }}</span>
          <span class="flex-1" />
          <span v-if="!engineUp" class="mr-2 text-xs opacity-60">Start the engine to run it.</span>
          <button class="btn btn-sm" :disabled="!engineUp || (run !== null && !run.done)" @click="act('pull')">Pull</button>
          <button class="btn btn-sm" :disabled="!engineUp || (run !== null && !run.done)" @click="act('build')">Build</button>
          <button class="btn btn-sm" :disabled="!engineUp || (run !== null && !run.done)" @click="act('stop')">Stop</button>
          <button class="btn btn-sm text-error" :disabled="!engineUp || (run !== null && !run.done)" title="Removes the containers and networks; volumes stay" @click="act('down')">Down</button>
          <button class="btn btn-primary btn-sm" :disabled="!engineUp || (run !== null && !run.done)" @click="act('up')">Up</button>
        </div>
        <RunPanel v-if="run" :run="run" tall @close="runToken = null" />
        <div v-else class="h-2" />
      </template>
    </div>
    <div class="modal-backdrop" @click="close" />

    <dialog v-if="leaving" open class="modal modal-open z-[1000]" @keydown.esc.stop.prevent="leaving = false">
      <div class="modal-box w-[28rem] max-w-[95vw] space-y-3">
        <div class="flex items-start gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood mood="question" class="size-8" /></span>
          <div class="min-w-0">
            <h3 class="text-lg font-semibold tracking-tight">Save the changes?</h3>
            <p class="text-sm opacity-70">{{ name }} has changes that are not saved yet. Up and Build use the file as it is saved.</p>
          </div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="leaving = false">Keep editing</button>
          <button class="btn btn-ghost btn-sm text-error" @click="emit('close')">Discard</button>
          <button class="btn btn-primary btn-sm" @click="saveAndClose">Save</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="leaving = false" />
    </dialog>

    <dialog v-if="preview" open class="modal modal-open" @keydown.esc.stop="preview = null">
      <div class="modal-box w-[46rem] max-w-[95vw] space-y-3">
        <h3 class="text-lg font-semibold tracking-tight">What Write with AI sends</h3>
        <p class="text-sm opacity-65">To {{ preview.provider }} · <span class="font-mono">{{ preview.model }}</span>. The file in the editor (obvious secrets masked) and your request.</p>
        <pre class="selectable max-h-[55vh] overflow-auto rounded-lg bg-base-200/70 p-3 font-mono text-[11px] whitespace-pre-wrap">{{ preview.system }}

{{ preview.messages.map((m) => `${m.role}: ${m.text}`).join('\n\n') }}</pre>
        <div class="modal-action"><button class="btn btn-sm" @click="preview = null">Close</button></div>
      </div>
    </dialog>
  </dialog>
</template>
