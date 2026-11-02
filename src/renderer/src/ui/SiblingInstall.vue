<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { currentOS } from '@shared/platform';
import type { SiblingApp } from '@shared/types';
import { api, attempt, siblingAsk, siblingTask } from '../store';
import devcatzLogo from '../assets/logos/devcatz.png';
import dbcatzLogo from '../assets/logos/dbcatz.png';
import dialcatzLogo from '../assets/logos/dialcatz.png';
import TaskSteps from './TaskSteps.vue';

/**
 * A link wants another Catzoid app that is not installed ("Open in DevCatz" on a gateway, "Open in DialCatz" on a
 * project): what that app is, and on Windows Download & Install — its latest release from GitHub, checked against the
 * release's SHA-256, installed for this user — then the link opens there. On macOS its download page (a DMG is
 * dragged to Applications by the user). The mirror of DevCatz's "DoCatz is not installed" (DoCatzButton.vue).
 */
const ABOUT: Record<SiblingApp, { name: string; logo: string; what: string }> = {
  devcatz: {
    name: 'DevCatz',
    logo: devcatzLogo,
    what: 'DevCatz is the local development app that goes with DoCatz: your sites on their own domains with HTTPS, runtimes, databases — and the gateways (WhatsApp, SMS, email, push) it runs on DoCatz’s engine. It installs, starts and stops them.',
  },
  dbcatz: { name: 'DBCatz', logo: dbcatzLogo, what: 'DBCatz is the database client that goes with DoCatz: the databases in your containers, browsed, queried and backed up.' },
  dialcatz: {
    name: 'DialCatz',
    logo: dialcatzLogo,
    what: 'DialCatz is the API client that goes with DoCatz: a project’s HTTP services become an environment, with its routes ready as requests.',
  },
};
const task = siblingTask;
const installing = computed(() => !!task.value && !task.value.done && !task.value.error);
const app = computed(() => (siblingAsk.value ? ABOUT[siblingAsk.value.which] : null));
const win = currentOS === 'windows';
const info = ref<{ site: string; platform: string } | null>(null);
onMounted(async () => (info.value = await api.appInfo().catch(() => null)));

const install = () => siblingAsk.value && attempt(() => api.siblingInstall(siblingAsk.value!.which, siblingAsk.value!.link));
function close() {
  if (installing.value) return;
  siblingAsk.value = null;
  task.value = null;
}
const download = () => info.value?.site && siblingAsk.value && api.openUrl(`${info.value.site}/download/${siblingAsk.value.which}${info.value.platform ? `/${info.value.platform}` : ''}`);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="siblingAsk && app" open class="modal modal-open" @keydown.esc="close">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-4">
          <img :src="app.logo" alt="" class="size-16 shrink-0 drop-shadow-md" draggable="false" />
          <div class="min-w-0 space-y-1">
            <h3 class="text-lg font-semibold tracking-tight">{{ app.name }} is not installed</h3>
            <p class="text-sm opacity-70">{{ app.what }}</p>
          </div>
        </div>
        <TaskSteps v-if="task" :task="task" />
        <p v-else-if="win" class="rounded-box bg-base-200/60 px-3 py-2 text-xs opacity-70">
          Download &amp; Install gets {{ app.name }}’s latest release from GitHub, checks it against the release’s SHA-256, installs it for your account (no
          administrator prompt) and opens it here. Free and open source.
        </p>
        <p v-else class="rounded-box bg-base-200/60 px-3 py-2 text-xs opacity-70">
          Its download page has the build for this Mac. Once it is in Applications, click Open in {{ app.name }} again. Free and open source.
        </p>
        <div v-if="task?.error && !task.cancelled" role="alert" class="alert alert-error alert-soft text-sm">
          <span class="selectable min-w-0 flex-1">{{ task.error }}</span>
          <button v-if="info?.site" class="btn btn-ghost btn-xs" @click="download">Download page</button>
        </div>
        <div class="modal-action mt-0">
          <button v-if="installing" class="btn btn-ghost btn-sm" @click="api.siblingInstallCancel()">Cancel</button>
          <template v-else-if="task?.done && !task.error">
            <button class="btn btn-primary btn-sm" @click="close">Done</button>
          </template>
          <template v-else>
            <button class="btn btn-ghost btn-sm" @click="close">Not now</button>
            <button v-if="win" class="btn btn-primary btn-sm" @click="install">{{ task?.error ? 'Try again' : 'Download & Install' }}</button>
            <button v-else class="btn btn-primary btn-sm" :disabled="!info?.site" @click="download(); close()">Download page</button>
          </template>
        </div>
      </div>
      <div class="modal-backdrop" @click="close" />
    </dialog>
  </Teleport>
</template>
