<script setup lang="ts">
import { computed } from 'vue';
import { api, attempt, engine, section } from '../store';
import CatMood from './CatMood.vue';
import TaskSteps from './TaskSteps.vue';

/**
 * What a section shows while the engine is not running: why, and the one button that fixes it — or the steps of a
 * start in progress (a job that waits on downloads shows its steps, never just a spinner; Catzoid #81).
 */
const s = computed(() => engine.value);
/** Linux (#101): the engine is the system's Docker Engine; missing means it is not installed. */
const noDocker = computed(() => s.value?.backend === 'system' && s.value.status === 'missing');
const title = computed(() => {
  switch (s.value?.status) {
    case 'missing':
      return noDocker.value ? 'Docker Engine is not installed' : 'The engine is not set up yet';
    case 'starting':
      return s.value?.task?.title ? `${s.value.task.title}…` : 'Starting the engine…';
    case 'stopping':
      return 'Stopping the engine…';
    case 'error':
      return 'The engine needs attention';
    case 'unsupported':
      return 'The engine cannot run here';
    default:
      return 'The engine is stopped';
  }
});
const start = () => attempt(() => api.engineStart());
</script>

<template>
  <div class="grid h-full place-items-center p-8">
    <div class="w-full max-w-lg space-y-4 text-center">
      <CatMood :mood="s?.status === 'error' || s?.task?.error ? 'error' : s?.status === 'unsupported' ? 'warning' : 'info'" class="mx-auto size-16" />
      <div class="space-y-1">
        <h2 class="text-lg font-semibold tracking-tight">{{ title }}</h2>
        <p v-if="s?.task?.error || !s?.task" class="text-sm opacity-65">{{ s?.task?.error || s?.message || 'Start it to see your containers, images, volumes and networks.' }}</p>
      </div>
      <TaskSteps v-if="s?.task && !s.task.error" :task="s.task" class="text-left" />
      <div v-if="s?.task && !s.task.error" class="flex justify-center"><button class="btn btn-ghost btn-sm" @click="api.engineCancel()">Cancel</button></div>
      <div v-else-if="s?.needs" class="flex justify-center gap-2">
        <button v-if="s.needs === 'install-wsl'" class="btn btn-primary btn-sm" @click="attempt(() => api.engineSetupWsl())">{{ s.task?.error ? 'Try again' : 'Install WSL' }}</button>
        <button v-else class="btn btn-primary btn-sm" @click="attempt(() => api.restartComputer())">Restart Windows</button>
      </div>
      <div v-else-if="s && !['unsupported', 'starting', 'stopping'].includes(s.status)" class="flex justify-center gap-2">
        <button class="btn btn-primary btn-sm" @click="start">{{ noDocker ? (s.task?.error ? 'Try again' : 'Install Docker Engine') : s.status === 'missing' ? 'Set up and start' : s.task?.error ? 'Try again' : 'Start engine' }}</button>
        <button class="btn btn-ghost btn-sm" @click="section = 'engine'">Engine settings</button>
      </div>
      <p v-if="noDocker && !s?.task" class="text-xs opacity-55">Or in a terminal: <span class="selectable font-mono">sudo apt install docker.io docker-compose-v2</span></p>
    </div>
  </div>
</template>
