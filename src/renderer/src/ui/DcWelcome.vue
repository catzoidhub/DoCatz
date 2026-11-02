<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, onMounted, ref } from 'vue';
import { api, attempt, engine, section } from '../store';
import CatMood from './CatMood.vue';

/**
 * First-run welcome (the Catzoid family's Get started, as DevCatz's WelcomeDialog): what DoCatz does and three first
 * steps, each with why. Shown once, on a true first launch — never seen and no engine set up yet — so an update never
 * shows it.
 */
const KEY = 'docatz.welcomeSeen';
const seen = ref(true);
try {
  seen.value = localStorage.getItem(KEY) === '1';
} catch {
  /* no storage: treat as seen */
}
const site = ref('');
const devcatz = ref(false);
onMounted(async () => {
  const info = await api.appInfo().catch(() => null);
  site.value = info?.site ?? '';
  devcatz.value = !!info?.siblings.devcatz;
});
const open = computed(() => !seen.value && engine.value?.status === 'missing');

function done() {
  seen.value = true;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* fine: it shows once more next time */
  }
}
function setUp() {
  done();
  section.value = 'engine';
  void attempt(() => api.engineStart());
}
const privacy = () => site.value && api.openUrl(`${site.value}/docs/privacy-and-data`);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open" open class="modal modal-open" @keydown.esc="done">
      <div class="modal-box w-[38rem] max-w-[95vw] space-y-5">
        <div class="flex items-start gap-3">
          <CatMood mood="success" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Welcome to DoCatz</h3>
            <p class="text-sm opacity-70">A light Docker engine for {{ words.thisComputer }}: your containers grouped by compose project, with logs, a terminal, files and a domain each.</p>
          </div>
        </div>

        <div class="space-y-1">
          <p class="label-caps">Three things to know first</p>
          <p class="text-xs opacity-60">Everything DoCatz downloads goes into one folder (~/.docatz) and is checked against a known checksum.</p>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">1 · Set up the engine</p>
                <p class="mt-1 text-sm opacity-70">
                  {{ engine?.backend === 'wsl' ? 'A small Linux distro in WSL 2 runs Docker.' : 'A small Linux VM on Apple’s Virtualization framework runs Docker, with fast file sharing for your home folder.' }}
                  The first start downloads about 1 GB and takes a few minutes; after that it starts in seconds.
                </p>
              </div>
              <button class="btn btn-primary btn-sm shrink-0" @click="setUp">Set up now</button>
            </div>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <p class="font-medium">2 · Your docker keeps working</p>
            <p class="mt-1 text-sm opacity-70">
              DoCatz brings its own docker, compose and buildx and adds a <span class="font-mono">docatz</span> context. Nothing switches until you choose
              <b>Use DoCatz as the default</b> in Engine — Docker Desktop or OrbStack can stay side by side.
            </p>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">3 · A domain for every container</p>
                <p class="mt-1 text-sm opacity-70">
                  A container that publishes a port opens at <span class="font-mono">https://web.shop.docatz.localhost</span>.
                  {{ devcatz ? 'The domain ending, HTTPS certificate and URLs without a port are shared with DevCatz.' : 'With DevCatz installed, the domain ending and certificate are shared between both.' }}
                </p>
              </div>
              <span v-if="devcatz" class="badge badge-success badge-sm shrink-0">DevCatz found</span>
            </div>
          </div>
        </div>

        <p class="text-xs opacity-60">
          AI is off until you turn it on in Settings → AI, and then it gets container names and states — never environment values or secrets.
          <a v-if="site" class="link" @click="privacy">What DoCatz sends</a>
        </p>

        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm" @click="done">Maybe later</button>
          <button class="btn btn-primary btn-sm" @click="setUp">Get started</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="done" />
    </dialog>
  </Teleport>
</template>
