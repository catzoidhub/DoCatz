<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, attempt, engine } from '../store';
import { engineCards, engineRows, type EngineKind } from './engines';

/**
 * The first set-up's choice of engine (#106, user 2026-11-21: on a new DoCatz nothing said Lite existed, so everyone set
 * up Standard): two cards to pick from, with DoCatz's own numbers, and one button that sets the chosen one up. Shown in
 * the welcome, on a section while nothing is set up, and on the Engine page. Both stay switchable in Engine → Settings.
 */
const props = defineProps<{ disabled?: boolean; compact?: boolean }>();
const emit = defineEmits<{ started: [] }>();

const wsl = computed(() => engine.value?.backend === 'wsl');
const cards = computed(() => engineCards(wsl.value));
const rows = computed(() => (props.compact ? engineRows(wsl.value).slice(0, 3) : engineRows(wsl.value)));
const picked = ref<EngineKind>(engine.value?.config?.kind ?? 'standard');
const busy = ref(false);
/** A Mac (user, 2026-11-21): the VM's CPUs, memory and disk are chosen with the engine — as Engine → Settings later. */
const mac = computed(() => engine.value?.backend === 'lima' || engine.value?.backend === 'lite');
const host = computed(() => engine.value?.host ?? { cpus: 4, memoryGiB: 8 });
const cpus = ref(engine.value?.config?.cpus ?? 2);
const memoryGiB = ref(engine.value?.config?.memoryGiB ?? 4);
const diskGiB = ref(engine.value?.config?.diskGiB ?? 64);

async function setUp() {
  busy.value = true;
  emit('started');
  await attempt(() => api.engineSetUp(picked.value, mac.value ? { cpus: cpus.value, memoryGiB: memoryGiB.value, diskGiB: diskGiB.value } : undefined));
  busy.value = false;
}
</script>

<template>
  <div class="space-y-3">
    <div class="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Engine">
      <button
        v-for="e in cards"
        :key="e.kind"
        type="button"
        role="radio"
        :aria-checked="picked === e.kind"
        class="flex flex-col gap-2 rounded-box border p-3 text-left transition-colors"
        :class="picked === e.kind ? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30' : 'border-base-300/70 bg-base-100 hover:border-base-content/25'"
        :disabled="disabled || busy"
        @click="picked = e.kind"
      >
        <span class="flex items-center gap-2">
          <span class="grid size-4 shrink-0 place-items-center rounded-full border" :class="picked === e.kind ? 'border-primary' : 'border-base-content/30'">
            <span v-if="picked === e.kind" class="size-2 rounded-full bg-primary" />
          </span>
          <span class="font-semibold tracking-tight">{{ e.name }}</span>
          <span v-if="e.kind === 'lite'" class="badge badge-xs badge-soft badge-warning">beta</span>
        </span>
        <span class="text-xs leading-relaxed opacity-65">{{ e.about }}</span>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <template v-for="row in rows" :key="row[0]">
            <dt class="opacity-55">{{ row[0] }}</dt>
            <dd class="font-medium">{{ e.kind === 'lite' ? row[2] : row[1] }}</dd>
          </template>
        </dl>
      </button>
    </div>
    <div v-if="mac" class="space-y-2 rounded-box border border-base-300/70 bg-base-100 p-3 text-left">
      <p class="label-caps">Resources for the VM</p>
      <label class="grid grid-cols-[5rem_1fr_4.5rem] items-center gap-3 text-sm">
        <span>CPUs</span>
        <input v-model.number="cpus" type="range" class="range range-primary range-xs" min="1" :max="host.cpus" :disabled="disabled || busy" />
        <span class="text-right tabular-nums">{{ cpus }} of {{ host.cpus }}</span>
      </label>
      <label class="grid grid-cols-[5rem_1fr_4.5rem] items-center gap-3 text-sm">
        <span>Memory</span>
        <input v-model.number="memoryGiB" type="range" class="range range-primary range-xs" min="1" :max="Math.max(2, host.memoryGiB - 2)" :disabled="disabled || busy" />
        <span class="text-right tabular-nums">{{ memoryGiB }} GB</span>
      </label>
      <label class="grid grid-cols-[5rem_1fr_4.5rem] items-center gap-3 text-sm">
        <span>Disk</span>
        <input v-model.number="diskGiB" type="range" class="range range-primary range-xs" min="16" max="512" step="8" :disabled="disabled || busy" />
        <span class="text-right tabular-nums">{{ diskGiB }} GB</span>
      </label>
      <p class="text-xs opacity-60">The disk is the most it may grow to; it only takes what is used, and can grow later but not shrink. All three can change later in Engine → Settings.</p>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-xs opacity-60">
        {{ wsl ? 'Both use the same disk: you can switch in Engine → Settings any time, nothing moves.' : 'You can switch in Engine → Settings any time; each engine keeps its own containers, images and volumes.' }}
      </p>
      <button class="btn btn-primary btn-sm shrink-0" :disabled="disabled || busy" @click="setUp">
        <span v-if="busy" class="loading loading-spinner loading-xs" />Set up {{ picked === 'lite' ? 'Lite' : 'Standard' }}
      </button>
    </div>
  </div>
</template>
