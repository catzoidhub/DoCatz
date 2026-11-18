<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { K8sState, K8sWorkloads } from '@shared/types';
import { ago, api, attempt, engineUp, errorText, notify } from '../store';
import DcNavButtons from './DcNavButtons.vue';
import EngineGate from './EngineGate.vue';

/**
 * Kubernetes (TODO #28): one local k3s cluster on DoCatz's engine, off until turned on. Pods run as containers of the
 * same Docker, so an image built with `docker build` runs in the cluster without a registry. Here: turn it on / off,
 * how to reach it (kubeconfig, context `docatz`), and what runs in it — pods, deployments, services.
 */
const s = ref<K8sState | null>(null);
const w = ref<K8sWorkloads | null>(null);
const tab = ref<'pods' | 'deployments' | 'services'>('pods');
const ns = ref('');
const busy = ref('');
const confirm = ref('');
const removing = ref(false);
const logs = ref<{ name: string; text: string } | null>(null);
let off: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  if (!engineUp.value) return;
  s.value = (await api.k8sState().catch(() => null)) ?? s.value;
  if (s.value?.status === 'running') w.value = (await api.k8sWorkloads().catch(() => null)) ?? w.value;
  else w.value = null;
}
onMounted(() => {
  off = api.onK8s((st) => (s.value = st));
  void load();
  // Pods change without an engine event of their own kind worth a push: a light poll while the page is open.
  timer = setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => {
  off?.();
  if (timer) clearInterval(timer);
});
watch(engineUp, load);

async function run(what: string, fn: () => Promise<K8sState>) {
  busy.value = what;
  try {
    s.value = await fn();
    await load();
  } catch (e) {
    notify('error', errorText(e));
    s.value = await api.k8sState().catch(() => s.value);
  }
  busy.value = '';
}
async function remove() {
  await run('remove', () => api.k8sRemove(confirm.value));
  removing.value = false;
  confirm.value = '';
}
async function showLogs(namespace: string, name: string) {
  logs.value = { name, text: 'Loading…' };
  logs.value = { name, text: (await attempt(() => api.k8sPodLogs(namespace, name))) ?? '' };
}
const delPod = (namespace: string, name: string) => attempt(() => api.k8sDeletePod(namespace, name), `Deleting ${name}`).then(load);

const namespaces = computed(() => [...new Set([...(w.value?.pods ?? []), ...(w.value?.deployments ?? []), ...(w.value?.services ?? [])].map((x) => x.namespace))].sort());
const inNs = <T extends { namespace: string }>(list: T[] | undefined) => (list ?? []).filter((x) => !ns.value || x.namespace === ns.value);
const pods = computed(() => inNs(w.value?.pods));
const deployments = computed(() => inNs(w.value?.deployments));
const services = computed(() => inNs(w.value?.services));
const podDot = (st: string) => (st === 'Running' || st === 'Completed' || st === 'Succeeded' ? 'status-success' : st === 'Pending' || st === 'ContainerCreating' ? 'status-warning' : 'status-error');
const STATUS: Record<string, string> = { off: 'Off', stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…' };
const useContext = computed(() => `export KUBECONFIG="$HOME/.kube/config:${s.value?.kubeconfig ?? ''}"\nkubectl config use-context docatz`);
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <div v-else class="flex h-full flex-col">
    <div class="drag win-top flex h-20 shrink-0 items-center gap-2 border-b border-base-300/60 px-5">
      <div class="no-drag"><DcNavButtons /></div>
      <h1 class="text-lg font-semibold tracking-tight">Kubernetes</h1>
      <span class="badge badge-xs badge-soft badge-warning">beta</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="!s" class="grid h-40 place-items-center"><span class="loading loading-spinner" /></div>
      <div v-else class="mx-auto max-w-4xl space-y-4 p-5">
        <!-- the cluster -->
        <div class="card">
          <div class="card-body gap-3">
            <div class="flex items-center gap-3">
              <span class="status status-lg" :class="s.status === 'running' ? 'status-success' : s.status === 'starting' || s.status === 'stopping' ? 'status-warning' : ''" />
              <div class="min-w-0 flex-1">
                <h2 class="text-base">{{ STATUS[s.status] }}</h2>
                <p class="text-xs opacity-60">{{ s.status === 'starting' || s.status === 'stopping' ? s.detail : `k3s ${s.version} · one node${s.node ? ` (${s.node})` : ''} · API on 127.0.0.1:${s.apiPort}` }}</p>
              </div>
              <template v-if="s.status === 'running'">
                <button class="btn btn-sm" :disabled="!!busy" @click="run('stop', () => api.k8sStop())"><span v-if="busy === 'stop'" class="loading loading-spinner loading-xs" />Stop</button>
              </template>
              <button v-else-if="s.status === 'off' || s.status === 'stopped'" class="btn btn-primary btn-sm" :disabled="!!busy" @click="run('start', () => api.k8sStart())">
                <span v-if="busy === 'start'" class="loading loading-spinner loading-xs" />{{ s.status === 'off' ? 'Turn on Kubernetes' : 'Start' }}
              </button>
            </div>
            <p v-if="s.error" class="selectable rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] text-error">{{ s.error }}</p>
            <p v-if="s.status === 'off'" class="text-sm opacity-70">
              One local cluster (k3s) on DoCatz’s engine. Its pods run as containers of the same Docker, so an image you build with <span class="font-mono text-xs">docker build</span> runs in the cluster at once — no registry. It
              takes about 600 MB of memory while it is on, and an 80 MB download the first time.
            </p>
          </div>
        </div>

        <!-- reaching it -->
        <div v-if="s.status === 'running'" class="card">
          <div class="card-body gap-2">
            <h2>kubectl</h2>
            <p class="text-sm opacity-70">
              The cluster’s kubeconfig is <span class="selectable font-mono text-xs">{{ s.kubeconfig }}</span> (context <span class="font-mono text-xs">docatz</span>).
              <span v-if="s.context" class="text-success">It is your current context.</span>
            </p>
            <pre class="selectable overflow-x-auto rounded-lg bg-base-200/70 px-3 py-2 font-mono text-xs leading-relaxed">{{ useContext }}</pre>
            <div class="flex gap-2">
              <button class="btn btn-sm" @click="api.copyText(useContext).then(() => notify('success', 'Copied'))">Copy</button>
              <button class="btn btn-ghost btn-sm" @click="api.reveal(s.kubeconfig)">Show the file</button>
            </div>
            <p class="text-xs opacity-55">DoCatz never changes your own ~/.kube/config. An image built here is used with <span class="font-mono">imagePullPolicy: Never</span> (or <span class="font-mono">IfNotPresent</span>).</p>
          </div>
        </div>

        <!-- what runs -->
        <div v-if="s.status === 'running' && w" class="card">
          <div class="card-body gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <div class="seg">
                <button class="seg-item" :class="{ 'is-active': tab === 'pods' }" @click="tab = 'pods'">Pods {{ pods.length }}</button>
                <button class="seg-item" :class="{ 'is-active': tab === 'deployments' }" @click="tab = 'deployments'">Deployments {{ deployments.length }}</button>
                <button class="seg-item" :class="{ 'is-active': tab === 'services' }" @click="tab = 'services'">Services {{ services.length }}</button>
              </div>
              <span class="flex-1" />
              <select v-model="ns" class="select select-sm w-48">
                <option value="">All namespaces</option>
                <option v-for="n in namespaces" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div class="overflow-x-auto">
              <table v-if="tab === 'pods'" class="table table-sm">
                <thead><tr><th>Pod</th><th>Namespace</th><th>Status</th><th>Ready</th><th>Restarts</th><th>Age</th><th /></tr></thead>
                <tbody>
                  <tr v-for="p in pods" :key="p.namespace + p.name" class="group">
                    <td class="max-w-64"><span class="block truncate font-medium" :title="p.image">{{ p.name }}</span><span class="block truncate text-[11px] opacity-50">{{ p.image }}</span></td>
                    <td class="opacity-70">{{ p.namespace }}</td>
                    <td><span class="status status-xs mr-1.5" :class="podDot(p.status)" />{{ p.status }}</td>
                    <td class="tabular-nums">{{ p.ready }}</td>
                    <td class="tabular-nums">{{ p.restarts }}</td>
                    <td class="whitespace-nowrap opacity-70">{{ ago(Date.parse(p.created)) }}</td>
                    <td class="whitespace-nowrap text-right">
                      <button class="btn btn-ghost btn-xs" @click="showLogs(p.namespace, p.name)">Logs</button>
                      <button class="btn btn-ghost btn-xs" title="Deletes the pod; a deployment starts a new one" @click="delPod(p.namespace, p.name)">Delete</button>
                    </td>
                  </tr>
                  <tr v-if="!pods.length"><td colspan="7" class="py-6 text-center opacity-60">No pods here.</td></tr>
                </tbody>
              </table>
              <table v-else-if="tab === 'deployments'" class="table table-sm">
                <thead><tr><th>Deployment</th><th>Namespace</th><th>Ready</th><th>Age</th></tr></thead>
                <tbody>
                  <tr v-for="d in deployments" :key="d.namespace + d.name">
                    <td class="font-medium">{{ d.name }}</td><td class="opacity-70">{{ d.namespace }}</td>
                    <td class="tabular-nums"><span class="status status-xs mr-1.5" :class="d.ready >= d.replicas ? 'status-success' : 'status-warning'" />{{ d.ready }}/{{ d.replicas }}</td>
                    <td class="opacity-70">{{ ago(Date.parse(d.created)) }}</td>
                  </tr>
                  <tr v-if="!deployments.length"><td colspan="4" class="py-6 text-center opacity-60">No deployments here.</td></tr>
                </tbody>
              </table>
              <table v-else class="table table-sm">
                <thead><tr><th>Service</th><th>Namespace</th><th>Type</th><th>Cluster IP</th><th>Ports</th><th>Age</th></tr></thead>
                <tbody>
                  <tr v-for="v in services" :key="v.namespace + v.name">
                    <td class="font-medium">{{ v.name }}</td><td class="opacity-70">{{ v.namespace }}</td><td>{{ v.type }}</td>
                    <td class="font-mono text-xs">{{ v.clusterIP ?? '—' }}</td>
                    <td class="font-mono text-xs">{{ v.ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol}`).join(' ') || '—' }}</td>
                    <td class="opacity-70">{{ ago(Date.parse(v.created)) }}</td>
                  </tr>
                  <tr v-if="!services.length"><td colspan="6" class="py-6 text-center opacity-60">No services here.</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- remove -->
        <div v-if="s.status !== 'off'" class="card">
          <div class="card-body gap-2">
            <h2>Remove the cluster</h2>
            <p class="text-sm opacity-70">Deletes the cluster and everything in it (its pods, volumes and settings). Your Docker containers, images and volumes stay.</p>
            <div v-if="removing" class="flex items-center gap-2">
              <input v-model="confirm" class="input input-sm w-40" placeholder="Type delete" spellcheck="false" @keydown.enter="remove" />
              <button class="btn btn-error btn-sm" :disabled="confirm.trim().toLowerCase() !== 'delete' || !!busy" @click="remove"><span v-if="busy === 'remove'" class="loading loading-spinner loading-xs" />Remove</button>
              <button class="btn btn-ghost btn-sm" @click="((removing = false), (confirm = ''))">Cancel</button>
            </div>
            <div v-else><button class="btn btn-sm" :disabled="!!busy" @click="removing = true">Remove…</button></div>
          </div>
        </div>
      </div>
    </div>

    <dialog v-if="logs" open class="modal modal-open" @keydown.esc="logs = null">
      <div class="modal-box w-[52rem] max-w-[95vw] space-y-3">
        <h3 class="text-base font-semibold">{{ logs.name }}</h3>
        <pre class="selectable max-h-[60vh] overflow-auto rounded-lg bg-base-200/70 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">{{ logs.text }}</pre>
        <div class="modal-action"><button class="btn btn-primary btn-sm" @click="logs = null">Close</button></div>
      </div>
      <div class="modal-backdrop" @click="logs = null" />
    </dialog>
  </div>
</template>
