<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, attempt, devcatzAsk, siblingTask } from '../store';
import devcatzLogo from '../assets/logos/devcatz.png';
import TaskSteps from './TaskSteps.vue';

/**
 * "Open in DevCatz" (a DevCatz gateway) when DevCatz is not installed: what DevCatz is, and Download & Install — its
 * latest release from GitHub, checked against the release's SHA-256, installed for this user — then the gateway opens
 * there. The mirror of DevCatz's "DoCatz is not installed" (DoCatzButton.vue). Windows, where the gateways are.
 */
const task = siblingTask;
const installing = computed(() => !!task.value && !task.value.done && !task.value.error);
const site = ref('');
onMounted(async () => (site.value = (await api.appInfo().catch(() => null))?.site ?? ''));

const install = () => devcatzAsk.value && attempt(() => api.siblingInstall('devcatz', devcatzAsk.value!.link));
function close() {
  if (installing.value) return;
  devcatzAsk.value = null;
  task.value = null;
}
const download = () => site.value && api.openUrl(`${site.value}/download/devcatz/win-x64`);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="devcatzAsk" open class="modal modal-open" @keydown.esc="close">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-4">
          <img :src="devcatzLogo" alt="" class="size-16 shrink-0 drop-shadow-md" draggable="false" />
          <div class="min-w-0 space-y-1">
            <h3 class="text-lg font-semibold tracking-tight">DevCatz is not installed</h3>
            <p class="text-sm opacity-70">
              DevCatz is the local development app that goes with DoCatz: your sites on their own domains with HTTPS, runtimes, databases — and the
              gateways (WhatsApp, SMS, email, push) it runs on DoCatz’s engine. It installs, starts and stops them.
            </p>
          </div>
        </div>
        <TaskSteps v-if="task" :task="task" />
        <p v-else class="rounded-box bg-base-200/60 px-3 py-2 text-xs opacity-70">
          Download &amp; Install gets DevCatz’s latest release from GitHub, checks it against the release’s SHA-256, installs it for your account (no
          administrator prompt) and opens this gateway there. Free and open source.
        </p>
        <div v-if="task?.error && !task.cancelled" role="alert" class="alert alert-error alert-soft text-sm">
          <span class="selectable min-w-0 flex-1">{{ task.error }}</span>
          <button v-if="site" class="btn btn-ghost btn-xs" @click="download">Download page</button>
        </div>
        <div class="modal-action mt-0">
          <button v-if="installing" class="btn btn-ghost btn-sm" @click="api.siblingInstallCancel()">Cancel</button>
          <template v-else-if="task?.done && !task.error">
            <button class="btn btn-primary btn-sm" @click="close">Done</button>
          </template>
          <template v-else>
            <button class="btn btn-ghost btn-sm" @click="close">Not now</button>
            <button class="btn btn-primary btn-sm" @click="install">{{ task?.error ? 'Try again' : 'Download & Install' }}</button>
          </template>
        </div>
      </div>
      <div class="modal-backdrop" @click="close" />
    </dialog>
  </Teleport>
</template>
