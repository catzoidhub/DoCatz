<script setup lang="ts">
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { DcContainer, DcTermData } from '@shared/types';
import { api, errorText, theme } from '../store';

/**
 * A shell inside the container (DoCatz TODO #13): `docker exec` with a terminal, bash when the image has it, else sh.
 * Ends when the shell exits or the tab closes; Reconnect opens a new one.
 */
const props = defineProps<{ container: DcContainer }>();
const host = ref<HTMLElement | null>(null);
const state = ref<'opening' | 'open' | 'ended' | 'error'>('opening');
const error = ref('');
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let session = '';
let off: (() => void) | null = null;
let ro: ResizeObserver | null = null;

const dark = () => theme.value === 'dark' || (theme.value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
const colours = () => (dark() ? { background: '#1b1d23', foreground: '#dfe2ea', cursor: '#8ec5ff', selectionBackground: '#3a4a66' } : { background: '#f7f8fa', foreground: '#2c3040', cursor: '#2479c9', selectionBackground: '#cfe3fb' });

async function open() {
  if (props.container.state !== 'running') {
    state.value = 'error';
    error.value = 'Start the container to open a terminal in it.';
    return;
  }
  state.value = 'opening';
  term?.reset();
  try {
    session = await api.termOpen(props.container.id, term!.cols, term!.rows);
    state.value = 'open';
    term!.focus();
  } catch (e) {
    state.value = 'error';
    error.value = errorText(e);
  }
}

onMounted(() => {
  term = new Terminal({ fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", fontSize: 12.5, cursorBlink: false, theme: colours(), scrollback: 5000, allowProposedApi: false });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value!);
  fit.fit();
  term.onData((d) => session && state.value === 'open' && void api.termInput(session, d));
  term.onResize(({ cols, rows }) => session && void api.termResize(session, cols, rows));
  ro = new ResizeObserver(() => fit?.fit());
  ro.observe(host.value!);
  off = window.docatz.onTerm((d: DcTermData) => {
    if (d.session !== session) return;
    if (d.data) term?.write(Uint8Array.from(atob(d.data), (ch) => ch.charCodeAt(0)));
    if (d.exited) {
      state.value = 'ended';
      session = '';
    }
  });
  void open();
});
onBeforeUnmount(() => {
  off?.();
  ro?.disconnect();
  if (session) void api.termClose(session);
  term?.dispose();
});
</script>

<template>
  <div class="relative flex h-full flex-col">
    <div v-if="state !== 'open'" class="flex shrink-0 items-center gap-2 border-b border-base-300/60 px-4 py-1.5 text-xs">
      <span v-if="state === 'opening'" class="loading loading-spinner loading-xs" />
      <span class="opacity-70">{{ state === 'opening' ? 'Opening a shell…' : state === 'ended' ? 'The shell ended.' : error }}</span>
      <span class="flex-1" />
      <button v-if="state === 'ended' || (state === 'error' && container.state === 'running')" class="btn btn-ghost btn-xs" @click="open">Reconnect</button>
    </div>
    <div ref="host" class="min-h-0 flex-1 px-2 py-1" :style="{ background: colours().background }" />
  </div>
</template>
