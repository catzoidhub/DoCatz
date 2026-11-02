<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { DcRun } from '@shared/types';
import { api } from '../store';

/** A compose run or image pull as it goes: its output, then done / failed; Cancel while it runs. */
const props = defineProps<{ run: DcRun; tall?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const box = ref<HTMLElement | null>(null);
watch(
  () => props.run.lines.length,
  () => nextTick(() => box.value && (box.value.scrollTop = box.value.scrollHeight)),
  { immediate: true },
);
</script>

<template>
  <div class="flex shrink-0 flex-col border-t border-base-300/60 bg-base-100">
    <div class="flex items-center gap-2 px-3 py-1.5">
      <span v-if="!run.done" class="loading loading-spinner loading-xs text-primary" />
      <span v-else class="status status-xs" :class="run.error ? 'status-error' : 'status-success'" />
      <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ run.title }}<template v-if="run.done"> — {{ run.error ?? 'done' }}</template></span>
      <button v-if="!run.done" class="btn btn-ghost btn-xs" @click="api.runCancel(run.token)">Cancel</button>
      <button v-else class="btn btn-ghost btn-xs btn-square" title="Close" @click="emit('close')">✕</button>
    </div>
    <pre ref="box" class="selectable overflow-auto bg-base-200/60 px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre-wrap" :class="tall ? 'h-64' : 'h-36'">{{ run.lines.join('\n') || '…' }}</pre>
  </div>
</template>
