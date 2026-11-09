<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, attempt, engine, section } from '../store';
import CatMood from './CatMood.vue';
import WslSetup from './WslSetup.vue';

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
// Windows without WSL 2 yet (needs: install / restart) is a first launch too: the dialog leads with installing it.
const open = computed(() => !seen.value && (engine.value?.status === 'missing' || !!engine.value?.needs));
const isWsl = computed(() => engine.value?.backend === 'wsl');
const needs = computed(() => engine.value?.needs ?? null);
const wslTask = computed(() => (engine.value?.task?.title === 'Installing WSL' ? engine.value.task : null));
const installWsl = () => attempt(() => api.engineSetupWsl());
const restartWindows = () => attempt(() => api.restartComputer());

/**
 * Closing it while Windows still needs WSL (or its restart) hides it for now only: after the restart DoCatz opens with
 * the welcome again — both checks green — to set up the engine. It is remembered as seen once nothing is left to do.
 */
function done() {
  seen.value = true;
  if (needs.value) return;
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
/**
 * The cards scroll inside the dialog, so it fits a window that is not full screen (on Windows the WSL checks and the
 * SVM how-to make it taller than one); the header and the buttons stay. A soft fade marks more above / below — as
 * DevCatz's WelcomeDialog.
 */
const list = ref<HTMLElement | null>(null);
const fadeTop = ref(false);
const fadeBottom = ref(false);
function edges() {
  const el = list.value;
  if (!el) return;
  fadeTop.value = el.scrollTop > 2;
  fadeBottom.value = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
}
let ro: ResizeObserver | null = null;
watch(list, (el) => {
  ro?.disconnect();
  if (!el) return;
  ro = new ResizeObserver(edges);
  ro.observe(el);
  for (const c of Array.from(el.children)) ro.observe(c);
  // Opens at the first card (the dialog's focus on a later button must not scroll the list down).
  void nextTick(() => {
    el.scrollTop = 0;
    edges();
  });
});
// The checks, a step line or the opened how-to change the cards' height.
watch(() => [engine.value?.needs, engine.value?.prereqs, engine.value?.task], () => void nextTick(edges), { deep: true });
onBeforeUnmount(() => ro?.disconnect());
const fade = computed(() => {
  const top = fadeTop.value ? 'transparent, black 1.25rem' : 'black';
  const bottom = fadeBottom.value ? 'black calc(100% - 1.25rem), transparent' : 'black';
  const m = `linear-gradient(to bottom, ${top}, ${bottom})`;
  return { maskImage: m, WebkitMaskImage: m };
});
const privacy = () => site.value && api.openUrl(`${site.value}/docs/privacy-and-data`);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open" open class="modal modal-open" @keydown.esc="done">
      <div class="modal-box win-fit flex max-h-[calc(100vh-2.5rem)] w-[38rem] max-w-[95vw] flex-col gap-5 overflow-hidden">
        <div class="flex shrink-0 items-start gap-3">
          <CatMood mood="success" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Welcome to DoCatz</h3>
            <p class="text-sm opacity-70">A light Docker engine for {{ words.thisComputer }}: your containers grouped by compose project, with logs, a terminal, files and a domain each.</p>
          </div>
        </div>

        <div class="shrink-0 space-y-1">
          <p class="label-caps">Three things to know first</p>
          <p class="text-xs opacity-60">Everything DoCatz downloads goes into one folder ({{ words.home }}.docatz) and is checked against a known checksum.</p>
        </div>

        <div ref="list" class="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 [scrollbar-width:thin]" :style="fade" @scroll.passive="edges" @toggle.capture="edges">
          <!-- Windows: WSL 2 first, which needs virtualisation on in the firmware -->
          <div v-if="isWsl" class="rounded-xl border p-4" :class="needs ? 'border-primary/50 bg-primary/5' : 'border-base-300/70 bg-base-200/40'">
            <p class="font-medium">{{ needs ? 'First · What Windows needs' : 'Windows is ready' }}</p>
            <p class="mt-1 text-sm opacity-70">The engine runs in WSL 2, Windows’ own Linux, which needs virtualisation on in the PC. DoCatz checked both:</p>
            <WslSetup class="mt-3" />
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4" :class="needs && 'opacity-60'">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">1 · Set up the engine</p>
                <p class="mt-1 text-sm opacity-70">
                  <template v-if="engine?.backend === 'system'">{{ engine.status === 'missing' ? 'Docker Engine is not on this computer yet. DoCatz installs it from your package manager (docker.io and Docker Compose) after one password prompt; it runs your containers directly, with no VM.' : 'Docker Engine from your package manager runs your containers directly, with no VM; DoCatz starts it after one password prompt.' }}</template>
                  <template v-else>
                    {{ engine?.backend === 'wsl' ? 'A small Linux distro in WSL 2 runs Docker.' : 'A small Linux VM on Apple’s Virtualization framework runs Docker, with fast file sharing for your home folder.' }}
                    The first start downloads about 1 GB and takes a few minutes; after that it starts in seconds.
                  </template>
                </p>
              </div>
              <button class="btn btn-primary btn-sm shrink-0" :disabled="!!needs" @click="setUp">{{ engine?.backend === 'system' && engine.status === 'missing' ? 'Install now' : 'Set up now' }}</button>
            </div>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <p class="font-medium">2 · Your docker keeps working</p>
            <p class="mt-1 text-sm opacity-70">
              DoCatz brings its own docker, compose and buildx and adds a <span class="font-mono">docatz</span> context. Nothing switches until you choose
              <b>Use DoCatz as the default</b> in Engine — {{ engine?.backend === 'system' ? 'the docker command you already have keeps working as it is.' : engine?.backend === 'wsl' ? 'Docker Desktop can stay side by side.' : 'Docker Desktop or OrbStack can stay side by side.' }}
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

        <p class="shrink-0 text-xs opacity-60">
          AI is off until you turn it on in Settings → AI, and then it gets container names and states — never environment values or secrets.
          <a v-if="site" class="link" @click="privacy">What DoCatz sends</a>
        </p>

        <div class="modal-action mt-0 shrink-0">
          <button class="btn btn-ghost btn-sm" @click="done">Maybe later</button>
          <button v-if="needs === 'install-wsl'" class="btn btn-primary btn-sm" :disabled="!!wslTask && !wslTask.error" @click="installWsl">Install WSL</button>
          <button v-else-if="needs === 'restart'" class="btn btn-primary btn-sm" @click="restartWindows">Restart now</button>
          <button v-else class="btn btn-primary btn-sm" @click="setUp">Get started</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="done" />
    </dialog>
  </Teleport>
</template>
