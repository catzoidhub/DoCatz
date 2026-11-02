<script setup lang="ts">
import { keyLabel } from '@shared/platform';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DcProjectEnv } from '@shared/types';
import { api, attempt, containers, notify, runs, token } from '../store';
import CodeEditor from '../components/CodeEditor.vue';
import CatMood from './CatMood.vue';
import RunPanel from './RunPanel.vue';

/**
 * A compose project's own .env in DoCatz (like a Dokploy app's environment page; laid out like DevCatz's .env tab):
 * create it from the project's .env or .env.example, edit, lock (values hidden, read-only). Its values go to the
 * containers whenever DoCatz runs the project — the project's own .env stays as DevCatz uses it on this computer.
 */
/** `embedded`: a tab of the project page (a toolbar instead of a page header, no Close). */
const props = defineProps<{ project: string; dir: string | null; embedded?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const state = ref<DcProjectEnv | null>(null);
const content = ref('');
const saved = ref('');
const mtime = ref<number | null>(null);
const dirty = computed(() => content.value !== saved.value);
const locked = computed(() => state.value?.locked !== false);

async function load() {
  state.value = (await attempt(() => api.envState(props.project, props.dir))) ?? null;
  if (!state.value?.exists) {
    content.value = saved.value = '';
    mtime.value = null;
    return;
  }
  const r = await attempt(() => api.envRead(props.project));
  if (!r) return;
  content.value = saved.value = r.content;
  mtime.value = r.mtime;
}
onMounted(async () => {
  await load();
  void checkDrift();
});
watch(() => props.project, load);

async function create(from: 'env' | 'example' | 'empty') {
  const s = await attempt(() => api.envCreate(props.project, props.dir, from));
  if (!s) return;
  notify('success', `${props.project}'s .env in DoCatz created`);
  await load();
}
async function save() {
  if (locked.value || !dirty.value) return;
  const at = await attempt(() => api.envWrite(props.project, content.value, mtime.value));
  if (at === undefined) return;
  saved.value = content.value;
  mtime.value = at;
  notify('success', 'Saved — run Build & Up to give the containers the new values.');
}
async function setLocked(on: boolean) {
  if (on && dirty.value && !confirm('Lock without saving your changes?')) return;
  if (on) content.value = saved.value;
  const s = await attempt(() => api.envLock(props.project, on));
  if (s && state.value) state.value = { ...state.value, locked: s.locked };
}
const onKey = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    void save();
  }
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

/** Locked view: keys and comments readable, values masked. */
const maskedText = computed(() =>
  saved.value
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=)(.*)$/);
      return m ? `${m[1]}${m[2].trim() ? '•'.repeat(Math.min(24, Math.max(8, m[2].trim().length))) : ''}` : line;
    })
    .join('\n'),
);
const problems = computed(() => {
  const out: string[] = [];
  const seen = new Map<string, number>();
  content.value.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/);
    if (!m) out.push(`Line ${i + 1}: not KEY=value`);
    else if (seen.has(m[1])) out.push(`${m[1]} is set twice (lines ${seen.get(m[1])} and ${i + 1}); the last one wins`);
    else seen.set(m[1], i + 1);
  });
  return out;
});
const varCount = computed(() => (locked.value ? saved.value : content.value).split('\n').filter((l) => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=/.test(l)).length);

// Build & Up through DoCatz, which hands the containers this .env (a container keeps the environment it was created with).
const runToken = ref<string | null>(null);
const run = computed(() => (runToken.value ? runs.value[runToken.value] : null));
async function recreate() {
  if (dirty.value) await save();
  runToken.value = token();
  await attempt(() => api.composeProject(props.project, 'build-up', runToken.value!));
}
/** Running containers whose environment differs from this .env (key names only): asked again after saves and runs. */
const drift = ref<{ container: string; service: string; keys: string[] }[]>([]);
async function checkDrift() {
  drift.value = state.value?.exists ? await api.envDrift(props.project).catch(() => []) : [];
}
watch([saved, () => run.value?.done, () => containers.value.filter((c) => c.project === props.project).map((c) => c.id).join()], () => void checkDrift());
const stale = computed(() => drift.value.map((d) => d.service));
const driftKeys = computed(() => [...new Set(drift.value.flatMap((d) => d.keys))]);
</script>

<template>
  <section class="flex h-full min-w-0 flex-col">
    <header class="flex shrink-0 gap-3 px-4" :class="embedded ? 'items-end pt-4 pb-2' : 'drag win-top h-20 items-center border-b border-base-300/60'">
      <div class="min-w-0 flex-1 pb-0.5">
        <h1 v-if="!embedded" class="truncate text-base font-semibold tracking-tight">{{ project }} · .env</h1>
        <p class="truncate text-xs opacity-55">What its containers get when DoCatz runs them. The project’s own .env stays as it is.</p>
      </div>
      <template v-if="state?.exists">
        <button v-if="locked" class="no-drag btn btn-sm" title="Show the values and allow editing" @click="setLocked(false)">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd" /></svg>
          Unlock
        </button>
        <button v-else class="no-drag btn btn-sm btn-ghost" title="Hide the values and stop editing" @click="setLocked(true)">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M14.5 1A4.5 4.5 0 0 0 10 5.5V9H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5V5.5a3 3 0 1 1 6 0v2.75a.75.75 0 0 0 1.5 0V5.5A4.5 4.5 0 0 0 14.5 1Z" clip-rule="evenodd" /></svg>
          Lock
        </button>
        <button class="no-drag btn btn-sm btn-primary" :disabled="run !== null && !run.done" title="docker compose up --build through DoCatz: rebuilds, then recreates the containers so they get these values" @click="recreate">Build &amp; Up</button>
      </template>
      <button v-if="!embedded" class="no-drag btn btn-ghost btn-sm btn-square" title="Close" @click="emit('close')">✕</button>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-3 p-5">
      <!-- Saved but not applied: the containers keep the environment they were created with -->
      <div v-if="state?.exists && stale.length && !(run && !run.done)" role="alert" class="alert alert-warning alert-soft text-sm">
        <CatMood mood="warning" class="-my-1 size-8 shrink-0" />
        <span class="min-w-0">{{ stale.join(', ') }} {{ stale.length === 1 ? 'does' : 'do' }} not have these values yet ({{ driftKeys.slice(0, 6).join(', ') }}{{ driftKeys.length > 6 ? ` +${driftKeys.length - 6}` : '' }}). Run <b>Build &amp; Up</b> to recreate {{ stale.length === 1 ? 'it' : 'them' }}. (Keys the compose file sets under <code>environment:</code> always win over any .env and are left out here.)</span>
        <button class="btn btn-warning btn-sm shrink-0" @click="recreate">Build &amp; Up</button>
      </div>
      <div v-if="!state" class="grid h-40 place-items-center"><span class="loading loading-spinner" /></div>
      <!-- Not created yet -->
      <div v-else-if="!state.exists" class="rounded-box border border-dashed border-base-300 p-6 text-center">
        <div class="font-medium">{{ project }} has no .env in DoCatz yet</div>
        <p class="mx-auto mt-1 max-w-lg text-xs opacity-70">Like a Dokploy app’s environment: set the values the containers need here (hosts like <code>postgres</code> instead of <code>127.0.0.1</code>), and the project’s .env keeps working for DevCatz on this computer.</p>
        <div class="mt-3 flex flex-wrap justify-center gap-2">
          <button v-if="state.projectEnv" class="btn btn-primary btn-sm" @click="create('env')">Start from {{ state.projectEnv }}</button>
          <button v-if="state.example" class="btn btn-sm" :class="{ 'btn-primary': !state.projectEnv }" @click="create('example')">Start from {{ state.example }}</button>
          <button class="btn btn-sm" :class="{ 'btn-primary': !state.projectEnv && !state.example }" @click="create('empty')">Start empty</button>
        </div>
      </div>
      <!-- Locked: masked, read-only -->
      <CodeEditor v-else-if="locked" :model-value="maskedText" language="env" readonly fill />
      <template v-else>
        <CodeEditor v-model="content" language="env" fill />
        <ul v-if="problems.length" class="text-xs text-warning">
          <li v-for="pr in problems.slice(0, 5)" :key="pr">{{ pr }}</li>
        </ul>
      </template>

      <div v-if="state?.exists" class="flex items-center gap-2 text-xs">
        <template v-if="!locked">
          <button class="btn btn-primary btn-sm" :disabled="!dirty" @click="save">Save <kbd class="kbd kbd-xs">{{ keyLabel('mod+S') }}</kbd></button>
          <button class="btn btn-ghost btn-sm" :disabled="!dirty" @click="content = saved">Revert</button>
        </template>
        <span class="opacity-60">{{ varCount }} variables<template v-if="locked"> · locked: values hidden, editing off</template><template v-else-if="dirty"> · unsaved changes</template></span>
      </div>
      <div v-if="state?.exists" role="note" class="flex items-start gap-2 text-xs opacity-60">
        <CatMood mood="info" class="size-6 shrink-0" />
        <span>DoCatz gives these values to every service when it runs {{ project }} (Build &amp; Up, Up, the compose dialog), on top of the project’s own .env. A container keeps the values it was created with: after a change, Build &amp; Up. A run started elsewhere (a terminal, DevCatz) uses the project’s .env only.</span>
      </div>
    </div>
    <RunPanel v-if="run" :run="run" tall @close="runToken = null" />
  </section>
</template>
