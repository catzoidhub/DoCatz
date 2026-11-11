<script setup lang="ts">
import { computed } from 'vue';
import type { TaskProgress } from '@shared/types';
import { taskPercent } from '@shared/task';

/**
 * The steps of a long job (engine setup, CLI install, domain setup …), as DevCatz's TaskStepper (user, 2026-11-10: the
 * same percentage bar in every Catzoid app): the title with the whole job's percentage and its bar, then each step —
 * done ✓, the current one with its detail and download bar.
 */
const props = defineProps<{ task: TaskProgress }>();
/** Finished steps plus the current step's own share (a download's fraction), by the steps' weights; 100 once done. */
const percent = computed(() => taskPercent(props.task));
</script>

<template>
  <div class="space-y-3 rounded-xl border border-base-300/70 bg-base-200/40 p-4" :class="{ 'border-error/40': task.error && !task.cancelled }">
    <div class="space-y-1.5">
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ task.cancelled ? 'Cancelled' : task.error ? `${task.title} — failed` : task.title }}</span>
        <span class="font-mono text-xs tabular-nums opacity-60">{{ percent }}%</span>
      </div>
      <progress class="progress h-1.5 w-full" :class="task.cancelled ? '' : task.error ? 'progress-error' : task.done ? 'progress-success' : 'progress-primary'" :value="percent" max="100" />
    </div>
    <ol class="space-y-2">
      <li v-for="(name, i) in task.steps" :key="name" class="flex items-start gap-3">
        <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold" :class="i < task.step || (task.done && !task.error) ? 'bg-success text-success-content' : i === task.step ? (task.error ? 'bg-error text-error-content' : 'bg-primary text-primary-content') : 'bg-base-300 opacity-60'">
          <template v-if="i < task.step || (task.done && !task.error)">✓</template>
          <span v-else-if="i === task.step && !task.error && !task.done" class="loading loading-spinner loading-xs" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm" :class="{ 'font-medium': i === task.step, 'opacity-50': i > task.step }">{{ name }}</p>
          <template v-if="i === task.step">
            <p v-if="task.detail" class="selectable mt-0.5 truncate text-xs opacity-60" :title="task.detail">{{ task.detail }}</p>
            <progress v-if="task.fraction !== undefined && task.fraction > 0" class="progress progress-primary mt-1.5 h-1.5 w-full" :value="Math.round(task.fraction * 100)" max="100" />
          </template>
        </div>
      </li>
    </ol>
  </div>
</template>
