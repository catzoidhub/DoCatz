<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { DcDomains } from '@shared/types';
import { words } from '@shared/platform';
import { api, errorText, notify } from '../store';
import TaskSteps from './TaskSteps.vue';

/**
 * Settings → Domains (DoCatz TODO #9 / #61): the default domain, HTTPS certificates and names without a port — the
 * same three settings DevCatz shows, kept in Catzoid/shared.json, set up with the same steps (a job that waits on an
 * OS prompt shows its steps, never just a spinner; Catzoid #81). They work with DoCatz alone too.
 */
const d = ref<DcDomains | null>(null);
const tldInput = ref('');
let off: (() => void) | null = null;
onMounted(async () => {
  d.value = await api.domains().catch(() => null);
  tldInput.value = d.value?.tld ?? 'localhost';
  off = window.docatz.onDomains((x) => (d.value = x));
});
onBeforeUnmount(() => off?.());

async function call(fn: () => Promise<DcDomains>) {
  try {
    d.value = await fn();
    tldInput.value = d.value.tld;
  } catch (e) {
    const msg = errorText(e);
    if (msg !== 'Cancelled') notify('error', msg);
    d.value = await api.domains().catch(() => d.value);
  }
}
const busy = computed(() => !!d.value?.task && !d.value.task.task.done);
const example = computed(() => (d.value ? `${d.value.https ? 'https' : 'http'}://web.shop.docatz.${d.value.tld}${d.value.cleanUrls.on && d.value.cleanUrls.reachesDocatz ? '' : `:${d.value.https ? d.value.httpsPort : d.value.httpPort}`}` : ''));
const appName = (o: string | null) => (o === 'devcatz' ? 'DevCatz' : o === 'docatz' ? 'DoCatz' : (o ?? ''));
const zoneNames = computed(() => (d.value?.resolver.zones ?? []).map((z) => `*.${z}`).join(' and '));
</script>

<template>
  <template v-if="d">
    <!-- Default domain -->
    <div class="card">
      <div class="card-body gap-3">
        <div class="flex items-center gap-2"><h2 class="flex-1">Default domain</h2><span class="badge badge-soft badge-primary badge-sm" title="DevCatz and DoCatz use the same domain ending">Shared with Catzoid apps</span></div>
        <p class="text-sm opacity-60">Every container that publishes a port opens at <span class="selectable font-mono">{{ example }}</span> — compose: service.project, others: the container’s name.</p>
        <form class="opt-row" @submit.prevent="call(() => api.setDomains({ tld: tldInput }))">
          <span class="flex min-w-0 flex-col">
            <span class="label-caps">Ending</span>
            <span class="text-xs opacity-50">{{ d.tld === 'localhost' ? '.localhost always points at this computer.' : `.${d.tld} needs a resolver (below).` }}</span>
          </span>
          <span class="flex items-center gap-1">
            <span class="opacity-50">.</span>
            <input v-model="tldInput" class="input input-sm w-32 font-mono" spellcheck="false" :disabled="busy" />
            <button class="btn btn-sm" :disabled="busy || tldInput.trim() === d.tld"><span v-if="d.task?.what === 'tld' && !d.task.task.done" class="loading loading-spinner loading-xs" />Save</button>
          </span>
        </form>
        <TaskSteps v-if="d.task?.what === 'tld'" :task="d.task.task" />
        <div v-if="d.resolver.needed" class="opt-row">
          <span class="flex min-w-0 flex-col">
            <span class="label-caps">{{ words.os === 'Windows' ? 'Register the names with Windows' : 'Resolver' }}</span>
            <span class="text-xs opacity-50">
              <template v-if="d.resolver.status === 'foreign'">Another tool already resolves these names — remove it there first.</template>
              <template v-else-if="d.resolver.status === 'ours' && d.resolver.resolves">{{ zoneNames }} resolve to {{ words.thisComputer }}.</template>
              <template v-else-if="words.os === 'Windows'">Only browsers resolve {{ zoneNames }} on Windows by themselves; DNS rules (NRPT) let every program reach the containers. Administrator approval once.</template>
              <template v-else-if="words.os === 'Linux'">Sends {{ zoneNames }} to the local DNS (a systemd-resolved rule, /etc/systemd/resolved.conf.d/devcatz-{{ d.tld }}.conf). Your password once.</template>
              <template v-else>Sends {{ zoneNames }} to the local DNS (/etc/resolver/{{ d.tld }}). Your administrator password once.</template>
              <template v-if="d.resolver.dnsError"> {{ d.resolver.dnsError }}</template>
            </span>
          </span>
          <button v-if="d.resolver.status !== 'ours'" class="btn btn-sm btn-primary" :disabled="busy || d.resolver.status === 'foreign'" @click="call(() => api.resolver(true))">{{ words.os === 'Windows' ? 'Register…' : 'Install…' }}</button>
          <button v-else class="btn btn-sm btn-ghost" :disabled="busy" @click="call(() => api.resolver(false))">Remove…</button>
        </div>
        <TaskSteps v-if="d.task?.what === 'dns'" :task="d.task.task" />
      </div>
    </div>

    <!-- HTTPS -->
    <div class="card">
      <div class="card-body gap-3">
        <div class="flex items-center gap-2"><h2 class="flex-1">HTTPS certificates</h2><span class="badge badge-soft badge-primary badge-sm" title="One local certificate authority for DevCatz and DoCatz">Shared with Catzoid apps</span></div>
        <p class="text-sm opacity-60">
          <template v-if="d.ca">One local certificate authority for the Catzoid apps (made by {{ appName(d.ca.by) }}). {{ d.ca.trusted ? `Trusted by ${words.thisComputer}: browsers show the lock.` : 'Not trusted yet: browsers warn until you trust it.' }}</template>
          <template v-else>No certificate yet: Trust makes one.</template>
        </p>
        <div class="opt-row">
          <span class="flex min-w-0 flex-col"><span class="label-caps">Trust the certificate</span><span class="text-xs opacity-50">{{ words.os === 'Windows' ? 'Adds it to your Trusted Root certificates — Windows asks “install this certificate?”' : words.os === 'Linux' ? 'Adds it to the system’s certificates and to Chrome’s and Firefox’s own stores — your password once.' : 'Adds it to your login keychain — macOS asks for your password or Touch ID.' }}</span></span>
          <button v-if="!d.ca?.trusted" class="btn btn-sm btn-primary" :disabled="busy" @click="call(() => api.caTrust(true))">Trust…</button>
          <button v-else class="btn btn-sm btn-ghost" :disabled="busy" @click="call(() => api.caTrust(false))">Remove…</button>
        </div>
        <label class="opt-row cursor-pointer">
          <span class="flex min-w-0 flex-col"><span class="label-caps">Serve container domains over HTTPS</span><span class="text-xs opacity-50">DoCatz’s own switch; off serves them over plain HTTP on :{{ d.httpPort }}.</span></span>
          <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="d.https" :disabled="busy" @change="call(() => api.setDomains({ https: ($event.target as HTMLInputElement).checked }))" />
        </label>
        <TaskSteps v-if="d.task?.what === 'ca'" :task="d.task.task" />
      </div>
    </div>

    <!-- Names without a port -->
    <div class="card">
      <div class="card-body gap-3">
        <div class="flex items-center gap-2"><h2 class="flex-1">URLs without a port</h2><span class="badge badge-soft badge-primary badge-sm" title="One :443 forwarding per computer, shared by DevCatz and DoCatz">Shared with Catzoid apps</span></div>
        <p class="text-sm opacity-60">
          Forwards ports 443 and 80 to {{ d.devcatz ? 'DevCatz’s proxy (so its sites keep working), which hands DoCatz’s names on' : 'DoCatz’s proxy' }}, so URLs need no :{{ d.httpsPort }}. {{ words.os === 'Windows' ? 'Administrator approval once.' : words.os === 'Linux' ? 'Your password once.' : 'Your administrator password once.' }}
        </p>
        <div class="opt-row">
          <span class="flex min-w-0 flex-col">
            <span class="label-caps">Names without a port</span>
            <span class="text-xs opacity-50">
              <template v-if="d.cleanUrls.on">On (to {{ appName(d.cleanUrls.by) }}’s proxy).<template v-if="d.cleanUrls.frontDown"> {{ appName(d.cleanUrls.by) }} is not running, so nothing answers on port 443: DoCatz’s names keep their :{{ d.httpsPort }} until {{ appName(d.cleanUrls.by) }} is open.</template><template v-else-if="!d.cleanUrls.reachesDocatz"> DoCatz’s names keep their :{{ d.httpsPort }} until DevCatz is updated to hand them on.</template></template>
              <template v-else>Off.</template>
            </span>
          </span>
          <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="d.cleanUrls.on" :disabled="busy" @change="call(() => api.cleanUrls(($event.target as HTMLInputElement).checked))" />
        </div>
        <TaskSteps v-if="d.task?.what === 'urls'" :task="d.task.task" />
        <p class="text-xs opacity-50">DoCatz’s proxy listens on {{ d.httpsPort }} (HTTPS) and {{ d.httpPort }} (HTTP), on {{ words.thisComputer }} only.</p>
      </div>
    </div>
  </template>
  <div v-else class="grid h-24 place-items-center"><span class="loading loading-spinner" /></div>
</template>
