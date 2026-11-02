<script setup lang="ts">
import type { TaskProgress } from '@shared/types';

/** The steps of a long job (engine setup, CLI install): done ✓, the current one with its detail and download bar. */
defineProps<{ task: TaskProgress }>();
</script>

<template>
  <ol class="space-y-2 rounded-xl border border-base-300/70 bg-base-200/40 p-4">
    <li v-for="(name, i) in task.steps" :key="name" class="flex items-start gap-3">
      <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold" :class="i < task.step ? 'bg-success text-success-content' : i === task.step ? (task.error ? 'bg-error text-error-content' : 'bg-primary text-primary-content') : 'bg-base-300 opacity-60'">
        <template v-if="i < task.step">✓</template>
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
</template>
