<script setup lang="ts">
import { computed } from 'vue';
import { api, attempt, engine } from '../store';
import CatMood from './CatMood.vue';
import TaskSteps from './TaskSteps.vue';

/**
 * Windows: what the engine stands on, checked one by one — virtualisation in the firmware (SVM / Intel VT-x) and WSL 2 —
 * each with a ✓ when it is on, so nothing is asked of the user that is already done. Install WSL shows its steps as they
 * happen; when it is done, Restart now with why. Shown in the Welcome dialog and in Settings → WSL.
 */
const s = computed(() => engine.value);
const needs = computed(() => s.value?.needs ?? null);
const prereqs = computed(() => s.value?.prereqs ?? null);
const virtualization = computed(() => prereqs.value?.virtualization ?? null);
const task = computed(() => (s.value?.task?.title === 'Installing WSL' ? s.value.task : null));
const installing = computed(() => !!task.value && !task.value.error);
const install = () => attempt(() => api.engineSetupWsl());
const restart = () => attempt(() => api.restartComputer());
const mark = (on: boolean | null) => (on ? 'bg-success text-success-content' : on === false ? 'bg-warning text-warning-content' : 'bg-base-300');
const wslLine = computed(() => {
  const p = prereqs.value;
  if (p?.wsl) return 'Installed and able to run Linux — nothing to do.';
  if (needs.value === 'restart') return 'Installed — Windows has to restart to finish (below).';
  if (installing.value) return 'Installing…';
  if (p?.wslInstalled) return 'Installed, but not able to run Linux yet: Install WSL turns on what it needs (administrator approval), then Windows restarts once.';
  return 'Not on this PC yet: Install WSL sets it up with one administrator prompt (a few minutes), then Windows restarts once.';
});
</script>

<template>
  <div class="space-y-3">
    <ul class="space-y-2.5">
      <li class="flex items-start gap-3">
        <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs font-bold" :class="mark(virtualization)">{{ virtualization ? '✓' : virtualization === false ? '!' : '?' }}</span>
        <div class="min-w-0 flex-1 text-sm">
          <p class="font-medium">Virtualisation (SVM / Intel VT-x)</p>
          <p class="opacity-70">{{ virtualization ? 'On in the BIOS / UEFI — nothing to do.' : virtualization === false ? 'Off in the BIOS / UEFI — turn it on first (below).' : 'Windows does not say — if WSL cannot start, turn it on (below).' }}</p>
        </div>
      </li>
      <li class="flex items-start gap-3">
        <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs font-bold" :class="mark(prereqs ? prereqs.wsl : null)">{{ prereqs?.wsl ? '✓' : '!' }}</span>
        <div class="min-w-0 flex-1 text-sm">
          <p class="font-medium">WSL 2</p>
          <p class="opacity-70">{{ wslLine }}</p>
          <p v-if="s?.status === 'unsupported' && !needs && s.message" class="mt-1 text-xs opacity-70">{{ s.message }}</p>
        </div>
        <button v-if="needs === 'install-wsl' && !installing" class="btn btn-primary btn-sm shrink-0" @click="install">{{ task?.error ? 'Try again' : 'Install WSL' }}</button>
      </li>
    </ul>

    <!-- the install, as it happens -->
    <TaskSteps v-if="task" :task="task" />
    <p v-if="installing" class="text-xs opacity-60">Keep DoCatz open until it is done. Windows works in the background; the PC may feel slower for a moment.</p>

    <!-- done: the restart, and why -->
    <div v-if="needs === 'restart'" role="alert" class="alert alert-info alert-soft items-start text-sm">
      <CatMood mood="success" class="-my-1 size-8 shrink-0" />
      <div class="min-w-0 flex-1 space-y-2">
        <p><b>WSL is installed — restart Windows to finish.</b></p>
        <p class="opacity-80">
          Windows turns on Virtual Machine Platform and loads WSL’s Linux kernel only while it starts up. Until the restart WSL 2 cannot start a virtual
          machine, so the engine cannot run yet.
        </p>
        <p class="opacity-80">Save your work in other apps first. After the restart, open DoCatz again: this shows again with both checks green, ready to set up the engine.</p>
        <button class="btn btn-primary btn-sm" @click="restart">Restart now</button>
      </div>
    </div>

    <!-- virtualisation: why, and how -->
    <div v-if="virtualization !== true && !prereqs?.wsl" role="alert" class="alert alert-warning alert-soft items-start text-sm">
      <CatMood mood="warning" class="-my-1 size-8 shrink-0" />
      <div class="min-w-0 space-y-2">
        <p>
          <b>Turn on virtualisation first.</b> WSL 2 needs it on in the PC’s BIOS / UEFI: <b>SVM Mode</b> on AMD processors, <b>Intel VT-x</b>
          (Virtualization Technology) on Intel. It is often off from the factory. In a virtual machine, its host has to allow nested virtualisation.
        </p>
        <details :open="virtualization === false">
          <summary class="cursor-pointer font-medium underline-offset-2 hover:underline">How to turn on SVM Mode / Intel VT-x</summary>
          <ol class="mt-2 list-decimal space-y-1.5 pl-5 opacity-90">
            <li>
              Restart the PC and press the BIOS key while the maker’s logo shows: <kbd class="kbd kbd-xs">Del</kbd> on most desktop boards (MSI, ASUS,
              Gigabyte, ASRock), <kbd class="kbd kbd-xs">F2</kbd> on many laptops, <kbd class="kbd kbd-xs">F10</kbd> on HP,
              <kbd class="kbd kbd-xs">F1</kbd> on Lenovo ThinkPad.
            </li>
            <li>If the BIOS opens in a simple view (EZ Mode), switch to Advanced Mode — <kbd class="kbd kbd-xs">F7</kbd> on MSI and ASUS.</li>
            <li>
              Find the setting (the names differ by maker):
              <ul class="mt-1 list-disc space-y-0.5 pl-4">
                <li><b>MSI</b>: OC → Advanced CPU Configuration → SVM Mode (older BIOS: OC → CPU Features, near the bottom of the OC page)</li>
                <li><b>ASUS</b>: Advanced → CPU Configuration → SVM Mode</li>
                <li><b>Gigabyte</b>: Tweaker → Advanced CPU Settings → SVM Mode</li>
                <li><b>ASRock</b>: Advanced → CPU Configuration → SVM Mode</li>
                <li><b>Intel boards</b>: Advanced → CPU Configuration → Intel Virtualization Technology</li>
                <li><b>Laptops</b>: often Configuration, Advanced or Security → Virtualization</li>
              </ul>
            </li>
            <li>Set it to <b>Enabled</b>, save with <kbd class="kbd kbd-xs">F10</kbd> → Yes, and let the PC restart.</li>
            <li>Open DoCatz again: the check above turns green once Windows sees it on.</li>
          </ol>
          <p class="mt-2 opacity-80">Not there at all? An older BIOS may hide it: update the BIOS from the board maker’s support page, then look again.</p>
        </details>
      </div>
    </div>
  </div>
</template>
