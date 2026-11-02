<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DcAiPreview, DcContainer, DcLogAnswer, DcLogChunk } from '@shared/types';
import { aiOn, api, errorText, notify, token } from '../store';
import CatMood from './CatMood.vue';

/**
 * Live logs of one container (DoCatz TODO #13): the last lines, then followed as they come; search, stdout / stderr,
 * timestamps. Pick lines (click, shift-click) and Explain with AI tells why it fails (TODO #20) — with Preview what is
 * sent first, and nothing it suggests runs by itself.
 */
const props = defineProps<{ container: DcContainer }>();
const MAX = 5000;
const lines = ref<{ n: number; stream: 'stdout' | 'stderr'; time: string; text: string }[]>([]);
const ended = ref(false);
const query = ref('');
const showTime = ref(false);
const stderrOnly = ref(false);
const follow = ref(true);
const box = ref<HTMLElement | null>(null);
let seq = 0;
let current = '';
let off: (() => void) | null = null;

async function start() {
  if (current) void api.logsStop(current);
  lines.value = [];
  ended.value = false;
  current = token();
  try {
    await api.logsFollow(props.container.id, 500, current);
  } catch (e) {
    notify('error', errorText(e));
  }
}
onMounted(() => {
  off = window.docatz.onLogs((c: DcLogChunk) => {
    if (c.token !== current) return;
    if (c.lines.length) {
      const add = c.lines.map((l) => ({ ...l, n: ++seq }));
      lines.value = [...lines.value, ...add].slice(-MAX);
      if (follow.value) void nextTick(() => box.value && (box.value.scrollTop = box.value.scrollHeight));
    }
    if (c.ended) ended.value = true;
  });
  void start();
});
watch(() => props.container.id, start);
// A stopped container's log ended; follow again when it starts.
watch(
  () => props.container.state,
  (s) => s === 'running' && ended.value && void start(),
);
onBeforeUnmount(() => {
  off?.();
  if (current) void api.logsStop(current);
});

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return lines.value.filter((l) => (!stderrOnly.value || l.stream === 'stderr') && (!q || l.text.toLowerCase().includes(q)));
});
function onScroll() {
  const el = box.value;
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

// ---- picking lines and Explain with AI
const picked = ref<Set<number>>(new Set());
let anchor: number | null = null;
function pick(n: number, e: MouseEvent) {
  if (window.getSelection()?.toString()) return;
  const s = new Set(e.metaKey || e.ctrlKey ? picked.value : []);
  if (e.shiftKey && anchor !== null) {
    const [a, b] = [Math.min(anchor, n), Math.max(anchor, n)];
    for (const l of shown.value) if (l.n >= a && l.n <= b) s.add(l.n);
  } else if (picked.value.has(n) && picked.value.size === 1) s.delete(n);
  else s.add(n);
  anchor = n;
  picked.value = s;
}
const pickedLines = computed(() => lines.value.filter((l) => picked.value.has(l.n)).map((l) => l.text));
const explainOn = aiOn('logs');
const prompt = ref('');
const asking = ref(false);
const answer = ref<DcLogAnswer | null>(null);
const preview = ref<DcAiPreview | null>(null);
let aiToken = '';
/** Nothing picked: the last 80 lines (most failures end there). */
const request = () => ({ containerId: props.container.id, lines: pickedLines.value.length ? pickedLines.value : lines.value.slice(-80).map((l) => l.text), prompt: prompt.value });
async function explain() {
  asking.value = true;
  answer.value = null;
  aiToken = token();
  try {
    answer.value = await api.aiExplainLog(request(), aiToken);
  } catch (e) {
    if (errorText(e) !== 'Stopped') notify('error', errorText(e));
  }
  asking.value = false;
}
async function showPreview() {
  try {
    preview.value = await api.aiPreviewLog(request());
  } catch (e) {
    notify('error', errorText(e));
  }
}
const copy = (t: string) => {
  void navigator.clipboard.writeText(t);
  notify('success', 'Copied');
};
const copyAll = () => copy(shown.value.map((l) => (showTime.value ? `${l.time} ${l.text}` : l.text)).join('\n'));
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-base-300/60 px-4 py-2">
      <label class="search-box flex w-60 items-center gap-2">
        <svg viewBox="0 0 20 20" class="size-3.5 shrink-0 opacity-50" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.27 9.92l3.15 3.16a.75.75 0 1 0 1.06-1.06l-3.16-3.15A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clip-rule="evenodd" /></svg>
        <input v-model="query" class="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="Filter lines" spellcheck="false" />
      </label>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs"><input v-model="stderrOnly" type="checkbox" class="checkbox checkbox-xs" />stderr only</label>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs"><input v-model="showTime" type="checkbox" class="checkbox checkbox-xs" />Times</label>
      <span class="flex-1" />
      <span v-if="picked.size" class="text-xs opacity-60">{{ picked.size }} picked <a class="link" @click="picked = new Set()">clear</a></span>
      <button class="btn btn-ghost btn-xs" @click="copyAll">Copy</button>
      <button class="btn btn-ghost btn-xs" @click="lines = []">Clear</button>
      <button v-if="explainOn" class="btn btn-primary btn-xs" :disabled="asking || !lines.length" :title="picked.size ? 'Explain the picked lines' : 'Explain the last 80 lines (pick lines to narrow it)'" @click="explain"><span v-if="asking" class="loading loading-spinner loading-xs" />✦ Explain with AI</button>
    </div>

    <div class="flex min-h-0 flex-1">
      <div ref="box" class="selectable min-w-0 flex-1 overflow-auto bg-base-200/40 py-2 font-mono text-[11.5px] leading-[1.45]" @scroll="onScroll">
        <p v-if="!lines.length" class="px-4 py-6 font-sans text-sm opacity-50">{{ ended ? 'No log lines.' : 'Waiting for log lines…' }}</p>
        <div v-for="l in shown" :key="l.n" class="flex cursor-default gap-3 px-4 whitespace-pre-wrap break-all" :class="[picked.has(l.n) ? 'bg-primary/20' : 'hover:bg-base-300/40', l.stream === 'stderr' ? 'text-error' : '']" @click="pick(l.n, $event)">
          <span v-if="showTime" class="shrink-0 opacity-45">{{ l.time.slice(11, 23) }}</span>
          <span>{{ l.text }}</span>
        </div>
        <p v-if="ended && lines.length" class="px-4 pt-2 font-sans text-xs opacity-45">— the container stopped; its log ends here —</p>
      </div>

      <!-- Explain with AI -->
      <aside v-if="explainOn && (asking || answer)" class="flex w-96 shrink-0 flex-col border-l border-base-300/60">
        <div class="flex items-center gap-2 border-b border-base-300/60 px-3 py-2">
          <CatMood :mood="asking ? 'question' : 'info'" class="size-7" />
          <span class="flex-1 text-sm font-semibold">Explain with AI</span>
          <button v-if="asking" class="btn btn-ghost btn-xs" @click="api.aiCancel(aiToken)">Stop</button>
          <button v-else class="btn btn-ghost btn-xs btn-square" @click="answer = null">✕</button>
        </div>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
          <p v-if="asking" class="opacity-60">Reading {{ picked.size || Math.min(80, lines.length) }} lines…</p>
          <template v-if="answer">
            <p class="font-medium">{{ answer.summary }}</p>
            <p class="opacity-80">{{ answer.cause }}</p>
            <ol v-if="answer.steps.length" class="list-decimal space-y-1 pl-5">
              <li v-for="s in answer.steps" :key="s">{{ s }}</li>
            </ol>
            <div v-if="answer.fix" class="space-y-1">
              <div class="flex items-center"><span class="label-caps flex-1">Suggested fix</span><button class="btn btn-ghost btn-xs" @click="copy(answer.fix)">Copy</button></div>
              <pre class="selectable overflow-x-auto rounded-lg bg-base-200/70 p-2 font-mono text-[11px] whitespace-pre-wrap">{{ answer.fix }}</pre>
            </div>
          </template>
        </div>
        <form class="space-y-1.5 border-t border-base-300/60 p-3" @submit.prevent="explain">
          <input v-model="prompt" class="input input-sm w-full" placeholder="Ask about these lines (optional)" />
          <div class="flex items-center gap-2"><a class="link text-xs opacity-60" @click="showPreview">Preview what is sent</a><span class="flex-1" /><button class="btn btn-primary btn-xs" :disabled="asking">Ask</button></div>
        </form>
      </aside>
    </div>

    <dialog v-if="preview" open class="modal modal-open" @keydown.esc="preview = null">
      <div class="modal-box w-[46rem] max-w-[95vw] space-y-3">
        <h3 class="text-lg font-semibold tracking-tight">What Explain with AI sends</h3>
        <p class="text-sm opacity-65">To {{ preview.provider }} · <span class="font-mono">{{ preview.model }}</span>. The container’s image, state and exit code, and the lines below with obvious secrets masked — nothing else.</p>
        <pre class="selectable max-h-[55vh] overflow-auto rounded-lg bg-base-200/70 p-3 font-mono text-[11px] whitespace-pre-wrap">{{ preview.system }}

{{ preview.messages.map((m) => `${m.role}: ${m.text}`).join('\n\n') }}</pre>
        <div class="modal-action"><button class="btn btn-sm" @click="preview = null">Close</button></div>
      </div>
      <div class="modal-backdrop" @click="preview = null" />
    </dialog>
  </div>
</template>
