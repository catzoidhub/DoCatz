<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { currentOS } from '@shared/platform';
import type { K8sDeployment, K8sPod, K8sService, K8sState, K8sWorkloads } from '@shared/types';
import { ago, api, attempt, engineUp, errorText, notify, PROJECT_ICON } from '../store';
import DcNavButtons from './DcNavButtons.vue';
import EngineGate from './EngineGate.vue';
import TaskSteps from './TaskSteps.vue';

/**
 * Kubernetes (TODO #28), laid out as the Containers and Builds pages (user, 2026-11-18: "lebih estetik dan user
 * friendly … pengelompokan misalnya antara pods dan services"): the list on the left — Pods, Services and Deployments,
 * each by namespace, the system namespaces folded away — and on the right what is picked, or the cluster itself.
 * One local k3s cluster on DoCatz's engine; its pods are containers of the same Docker, so an image from
 * `docker build` runs without a registry.
 */
type Kind = 'pod' | 'service' | 'deployment';
type Pick = { kind: Kind; namespace: string; name: string };

const s = ref<K8sState | null>(null);
const w = ref<K8sWorkloads | null>(null);
const busy = ref('');
const query = ref('');
const system = ref(false);
const folded = ref(new Set<Kind>());
const picked = ref<Pick | null>(null);
const confirm = ref('');
const removing = ref(false);
const logs = ref('');
const logsLoading = ref(false);
let off: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

// ------------------------------------------------------------------ data

let loading = false;
async function load() {
  // One at a time: a slow cluster must not get a second question before it answered the first.
  if (!engineUp.value || loading) return;
  loading = true;
  try {
    s.value = (await api.k8sState().catch(() => null)) ?? s.value;
    if (s.value?.status === 'running') w.value = (await api.k8sWorkloads().catch(() => null)) ?? w.value;
    else w.value = null;
  } finally {
    loading = false;
  }
}
onMounted(() => {
  off = api.onK8s((st) => (s.value = st));
  void load();
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
  picked.value = null;
}

// ------------------------------------------------------------------ the list

const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const visible = <T extends { namespace: string; name: string }>(list: T[] | undefined) =>
  (list ?? []).filter((x) => (system.value || !SYSTEM_NS.has(x.namespace)) && (!query.value || `${x.namespace}/${x.name}`.toLowerCase().includes(query.value.toLowerCase())));
const pods = computed(() => visible(w.value?.pods));
const services = computed(() => visible(w.value?.services).filter((x) => !(x.namespace === 'default' && x.name === 'kubernetes')));
const deployments = computed(() => visible(w.value?.deployments));
const hiddenSystem = computed(() => (w.value ? [...w.value.pods, ...w.value.services, ...w.value.deployments].filter((x) => SYSTEM_NS.has(x.namespace)).length : 0));

/** By namespace, `default` first. */
function byNs<T extends { namespace: string }>(list: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of list) m.set(x.namespace, [...(m.get(x.namespace) ?? []), x]);
  return [...m].sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
}
type Item = K8sPod | K8sService | K8sDeployment;
const GROUPS = computed<{ kind: Kind; label: string; items: Item[]; live: number }[]>(() => [
  { kind: 'pod', label: 'Pods', items: pods.value, live: pods.value.filter((p) => p.status === 'Running').length },
  { kind: 'service', label: 'Services', items: services.value, live: 0 },
  { kind: 'deployment', label: 'Deployments', items: deployments.value, live: deployments.value.filter((d) => d.replicas > 0 && d.ready >= d.replicas).length },
]);
const toggle = (k: Kind) => {
  const n = new Set(folded.value);
  if (n.has(k)) n.delete(k);
  else n.add(k);
  folded.value = n;
};
const isPicked = (kind: Kind, x: { namespace: string; name: string }) => picked.value?.kind === kind && picked.value.namespace === x.namespace && picked.value.name === x.name;
const pick = (kind: Kind, x: { namespace: string; name: string }) => (picked.value = { kind, namespace: x.namespace, name: x.name });

const ok = (st: string) => st === 'Running' || st === 'Completed' || st === 'Succeeded';
const podDot = (st: string) => (ok(st) ? 'status-success' : st === 'Pending' || st === 'ContainerCreating' || st === 'PodInitializing' ? 'status-warning' : 'status-error');
const depDot = (d: K8sDeployment) => (d.replicas === 0 ? '' : d.ready >= d.replicas ? 'status-success' : d.ready > 0 ? 'status-warning' : 'status-error');
const opened = (v: K8sService) => (v.type === 'LoadBalancer' ? v.ports.filter((p) => s.value?.published.includes(p.port)) : []);
const since = (t: string) => ago(Date.parse(t));
const matches = (sel: Record<string, string>, labels: Record<string, string>) => Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);
/** A row's dot and second line, by kind. */
function dotOf(kind: Kind, x: Item): string {
  if (kind === 'pod') return podDot((x as K8sPod).status);
  if (kind === 'deployment') return depDot(x as K8sDeployment) || 'bg-base-content/30';
  return '';
}
function lineOf(kind: Kind, x: Item): string {
  if (kind === 'pod') {
    const p = x as K8sPod;
    return `${p.status} · ${p.ready}${p.restarts ? ` · ${p.restarts} restarts` : ''} · ${since(p.created)}`;
  }
  if (kind === 'service') {
    const v = x as K8sService;
    return `${v.type} · ${v.ports.map((p) => `${p.port}/${p.protocol.toLowerCase()}`).join(' · ') || 'no ports'}`;
  }
  const d = x as K8sDeployment;
  return `${d.ready}/${d.replicas} ready · ${since(d.created)}`;
}
const badgeOf = (kind: Kind, x: Item): number | null => (kind === 'service' ? (opened(x as K8sService)[0]?.port ?? null) : null);

// ------------------------------------------------------------------ what is picked

const pod = computed<K8sPod | null>(() => (picked.value?.kind === 'pod' ? (w.value?.pods.find((p) => p.namespace === picked.value!.namespace && p.name === picked.value!.name) ?? null) : null));
const service = computed<K8sService | null>(() => (picked.value?.kind === 'service' ? (w.value?.services.find((p) => p.namespace === picked.value!.namespace && p.name === picked.value!.name) ?? null) : null));
const deployment = computed<K8sDeployment | null>(() => (picked.value?.kind === 'deployment' ? (w.value?.deployments.find((p) => p.namespace === picked.value!.namespace && p.name === picked.value!.name) ?? null) : null));
/** The pick went away (deleted, the cluster stopped): back to the cluster. */
watch(w, () => {
  if (picked.value && w.value && !pod.value && !service.value && !deployment.value) picked.value = null;
});
const podsOf = (sel: Record<string, string>, ns: string) => (w.value?.pods ?? []).filter((p) => p.namespace === ns && matches(sel, p.labels));
const servicesOfPod = computed(() => (pod.value ? (w.value?.services ?? []).filter((v) => v.namespace === pod.value!.namespace && matches(v.selector, pod.value!.labels)) : []));

async function readLogs() {
  if (!pod.value) return;
  logsLoading.value = true;
  logs.value = (await attempt(() => api.k8sPodLogs(pod.value!.namespace, pod.value!.name))) ?? '';
  logsLoading.value = false;
}
watch(
  () => (pod.value ? `${pod.value.namespace}/${pod.value.name}` : ''),
  (k) => {
    logs.value = '';
    if (k) void readLogs();
  },
);
async function deletePod() {
  if (!pod.value) return;
  const { namespace, name } = pod.value;
  await attempt(() => api.k8sDeletePod(namespace, name), `Deleting ${name}`);
  picked.value = null;
  await load();
}

// ------------------------------------------------------------------ the cluster

const STATUS: Record<string, string> = { off: 'Off', stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…' };
// Windows: PowerShell's own syntax and `;` between files (bash's `export … :` there was wrong; Windows PC, 2026-11-18).
const useContext = computed(() =>
  currentOS === 'windows'
    ? `$env:KUBECONFIG = "$HOME\\.kube\\config;${s.value?.kubeconfig ?? ''}"\nkubectl config use-context docatz`
    : `export KUBECONFIG="$HOME/.kube/config:${s.value?.kubeconfig ?? ''}"\nkubectl config use-context docatz`,
);
const userNs = <T extends { namespace: string }>(list: T[] | undefined) => (list ?? []).filter((x) => !SYSTEM_NS.has(x.namespace));
const TILES = computed(() => [
  { label: 'Pods running', value: `${userNs(w.value?.pods).filter((p) => p.status === 'Running').length}/${userNs(w.value?.pods).length}` },
  { label: 'Deployments', value: String(userNs(w.value?.deployments).length) },
  { label: 'Services', value: String(userNs(w.value?.services).filter((d) => !(d.namespace === 'default' && d.name === 'kubernetes')).length) },
  { label: 'Open on localhost', value: String(s.value?.published.length ?? 0) },
]);

const ICON: Record<Kind, string> = {
  pod: 'M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Zm0 1.68L5.04 6.65 10 9.13l4.96-2.48L10 4.18ZM4.5 7.86v5.21l4.75 2.37v-5.2L4.5 7.85Zm11 0-4.75 2.37v5.2l4.75-2.37V7.86Z',
  service: 'M10 2a2.5 2.5 0 0 1 .75 4.89V9h3.5a1.75 1.75 0 0 1 1.75 1.75v1.36a2.5 2.5 0 1 1-1.5 0v-1.36a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25v1.36a2.5 2.5 0 1 1-1.5 0v-1.36A1.75 1.75 0 0 1 5.75 9h3.5V6.89A2.5 2.5 0 0 1 10 2Z',
  deployment: PROJECT_ICON,
};
const WHEEL =
  'M10 1.5a.75.75 0 0 1 .75.75v1.56a6.2 6.2 0 0 1 2.9 1.2l1.1-1.1a.75.75 0 1 1 1.06 1.06l-1.1 1.1a6.2 6.2 0 0 1 1.2 2.9h1.56a.75.75 0 0 1 0 1.5h-1.56a6.2 6.2 0 0 1-1.2 2.9l1.1 1.1a.75.75 0 1 1-1.06 1.06l-1.1-1.1a6.2 6.2 0 0 1-2.9 1.2v1.56a.75.75 0 0 1-1.5 0v-1.56a6.2 6.2 0 0 1-2.9-1.2l-1.1 1.1a.75.75 0 0 1-1.06-1.06l1.1-1.1a6.2 6.2 0 0 1-1.2-2.9H2.25a.75.75 0 0 1 0-1.5h1.56a6.2 6.2 0 0 1 1.2-2.9l-1.1-1.1a.75.75 0 0 1 1.06-1.06l1.1 1.1a6.2 6.2 0 0 1 2.9-1.2V2.25A.75.75 0 0 1 10 1.5Zm0 3.75a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 0 0 0-9.5Zm0 3a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z';
const CHEVRON = 'M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z';
const INK = 'text-[var(--primary-ink,var(--color-primary))]';
</script>

<template>
  <EngineGate v-if="!engineUp" />
  <div v-else class="flex h-full">
    <!-- the list -->
    <aside class="flex w-80 shrink-0 flex-col border-r border-base-300/60 bg-base-200/40">
      <div class="drag win-top flex h-20 shrink-0 items-center gap-2 px-3">
        <div class="no-drag"><DcNavButtons /></div>
        <span class="label-caps">Kubernetes</span>
        <span class="badge badge-xs badge-soft badge-warning">beta</span>
        <span class="flex-1" />
        <button class="no-drag flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition hover:bg-base-300/50" :class="{ 'bg-base-300/50': !picked }" title="The cluster" @click="picked = null">
          <span class="status status-xs" :class="s?.status === 'running' ? 'status-success' : s?.status === 'starting' || s?.status === 'stopping' ? 'status-warning' : 'bg-base-content/30'" />
          {{ s ? STATUS[s.status] : '…' }}
        </button>
      </div>

      <template v-if="s?.status === 'running' && w">
        <div class="flex items-center gap-2 px-3 pb-2">
          <input v-model="query" class="input input-sm min-w-0 flex-1" placeholder="Filter" spellcheck="false" />
          <button class="btn btn-ghost btn-xs" :class="{ 'btn-active': system }" :title="system ? 'Hide kube-system and the other system namespaces' : `Show the system namespaces (${hiddenSystem})`" @click="system = !system">System</button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <section v-for="g in GROUPS" :key="g.kind" class="mb-2">
            <button class="group/sec flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left" @click="toggle(g.kind)">
              <span class="label-caps flex-1">{{ g.label }}</span>
              <span class="sec-count" :class="{ 'is-live': g.live > 0 }">{{ g.items.length }}</span>
              <svg class="size-3.5 shrink-0 opacity-45 transition group-hover/sec:opacity-90" :class="{ '-rotate-90': folded.has(g.kind) }" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" :d="CHEVRON" clip-rule="evenodd" /></svg>
            </button>
            <template v-if="!folded.has(g.kind)">
              <p v-if="!g.items.length" class="px-3 py-2 text-xs opacity-50">{{ g.kind === 'pod' ? 'No pods yet — kubectl run or apply one.' : g.kind === 'service' ? 'No services yet.' : 'No deployments yet.' }}</p>
              <div v-for="[ns, items] in byNs(g.items)" :key="g.kind + ns">
                <div class="px-3 pt-1.5 pb-0.5 font-mono text-[10.5px] tracking-wide opacity-45">{{ ns }}</div>
                <button
                  v-for="x in items"
                  :key="x.name"
                  class="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors"
                  :class="isPicked(g.kind, x) ? 'bg-primary/15 ring-1 ring-primary/30' : 'hover:bg-base-300/40'"
                  @click="pick(g.kind, x)"
                >
                  <span class="relative grid size-8 shrink-0 place-items-center rounded-lg border border-base-300/70 bg-base-100" :class="INK">
                    <svg viewBox="0 0 20 20" class="size-[17px]" fill="currentColor"><path :d="ICON[g.kind]" /></svg>
                    <span v-if="g.kind !== 'service'" class="status status-xs absolute -right-0.5 -bottom-0.5 ring-2 ring-base-200" :class="dotOf(g.kind, x)" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[13px] font-medium">{{ x.name }}</span>
                    <span class="block truncate text-[11px] opacity-55">{{ lineOf(g.kind, x) }}</span>
                  </span>
                  <span v-if="badgeOf(g.kind, x)" class="badge badge-xs badge-soft badge-primary shrink-0 font-mono" title="Open on localhost">:{{ badgeOf(g.kind, x) }}</span>
                </button>
              </div>
            </template>
          </section>
        </div>
      </template>
      <div v-else class="px-5 py-6 text-sm opacity-60">
        <template v-if="s?.status === 'starting'">{{ s.detail || 'Starting the cluster…' }}</template>
        <template v-else-if="s?.status === 'stopping'">{{ s.detail || 'Stopping…' }}</template>
        <template v-else>Pods, services and deployments show here while the cluster runs.</template>
      </div>
    </aside>

    <!-- what is picked -->
    <section class="flex min-w-0 flex-1 flex-col">
      <!-- a pod -->
      <template v-if="pod">
        <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl border border-base-300/70 bg-base-100" :class="INK"><svg viewBox="0 0 20 20" class="size-5" fill="currentColor"><path :d="ICON.pod" /></svg></span>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-semibold tracking-tight">{{ pod.name }}</h1>
            <p class="flex items-center gap-1.5 truncate text-xs opacity-60"><span class="status status-xs" :class="podDot(pod.status)" />{{ pod.status }} · {{ pod.ready }} ready · {{ pod.namespace }}</p>
          </div>
          <button class="no-drag btn btn-ghost btn-sm" :title="pod.deployment ? 'Its deployment starts a new one' : 'The pod goes for good'" @click="deletePod">Delete</button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="mx-auto max-w-4xl space-y-4 p-5">
            <div class="card">
              <div class="card-body gap-2">
                <h2>Pod</h2>
                <dl class="selectable grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt class="opacity-60">Namespace</dt><dd>{{ pod.namespace }}</dd>
                  <template v-if="pod.deployment">
                    <dt class="opacity-60">Deployment</dt>
                    <dd><a class="link link-hover" :class="INK" @click="pick('deployment', { namespace: pod.namespace, name: pod.deployment })">{{ pod.deployment }}</a></dd>
                  </template>
                  <template v-else-if="pod.owner"><dt class="opacity-60">Made by</dt><dd>{{ pod.owner.kind }} {{ pod.owner.name }}</dd></template>
                  <dt class="opacity-60">Pod IP</dt><dd class="font-mono text-xs leading-5">{{ pod.ip ?? '—' }}</dd>
                  <dt class="opacity-60">Node</dt><dd class="font-mono text-xs leading-5">{{ pod.node ?? '—' }}</dd>
                  <dt class="opacity-60">Restarts</dt><dd>{{ pod.restarts }}</dd>
                  <dt class="opacity-60">Created</dt><dd>{{ new Date(pod.created).toLocaleString() }} · {{ since(pod.created) }}</dd>
                  <template v-if="servicesOfPod.length">
                    <dt class="opacity-60">Services</dt>
                    <dd class="flex flex-wrap gap-x-3"><a v-for="v in servicesOfPod" :key="v.name" class="link link-hover" :class="INK" @click="pick('service', v)">{{ v.name }}</a></dd>
                  </template>
                </dl>
              </div>
            </div>
            <div class="card">
              <div class="card-body gap-2">
                <h2>Containers</h2>
                <ul class="space-y-1.5">
                  <li v-for="c in pod.containers" :key="c.name" class="flex items-center gap-3 rounded-lg bg-base-200/50 px-3 py-2">
                    <span class="status status-sm" :class="c.ready ? 'status-success' : ok(c.state) ? '' : 'status-error'" />
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm font-medium">{{ c.name }}</span>
                      <span class="selectable block truncate font-mono text-[11px] opacity-60">{{ c.image }}</span>
                    </span>
                    <span class="shrink-0 text-xs opacity-70">{{ c.state }}<template v-if="c.restarts"> · {{ c.restarts }} restarts</template><template v-if="c.ports.length"> · port {{ c.ports.join(', ') }}</template></span>
                  </li>
                </ul>
                <p v-if="['ErrImageNeverPull', 'ErrImagePull', 'ImagePullBackOff'].includes(pod.status)" class="text-xs text-warning">
                  An image you built with docker build is used as it is: set <span class="font-mono">imagePullPolicy: Never</span> (or <span class="font-mono">IfNotPresent</span>), and check its name and tag.
                </p>
              </div>
            </div>
            <div v-if="Object.keys(pod.labels).length" class="card">
              <div class="card-body gap-2">
                <h2>Labels</h2>
                <div class="flex flex-wrap gap-1.5">
                  <span v-for="(v, k) in pod.labels" :key="k" class="selectable rounded-md bg-base-200/70 px-2 py-0.5 font-mono text-[11px]">{{ k }}=<span class="opacity-70">{{ v }}</span></span>
                </div>
              </div>
            </div>
            <div class="card">
              <div class="card-body gap-2">
                <div class="flex items-center gap-2">
                  <h2 class="flex-1">Logs</h2>
                  <span v-if="logsLoading" class="loading loading-spinner loading-xs" />
                  <button class="btn btn-ghost btn-xs" @click="readLogs">Refresh</button>
                </div>
                <pre class="selectable max-h-[50vh] overflow-auto rounded-lg bg-base-200/60 p-3 font-mono text-[11px] leading-snug whitespace-pre-wrap">{{ logs || (logsLoading ? '' : 'No log lines yet.') }}</pre>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- a service -->
      <template v-else-if="service">
        <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl border border-base-300/70 bg-base-100" :class="INK"><svg viewBox="0 0 20 20" class="size-5" fill="currentColor"><path :d="ICON.service" /></svg></span>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-semibold tracking-tight">{{ service.name }}</h1>
            <p class="truncate text-xs opacity-60">{{ service.type }} · {{ service.namespace }}</p>
          </div>
          <button v-if="service.url" class="no-drag btn btn-primary btn-sm" :title="service.url" @click="api.openUrl(service.url)">Open</button>
          <button v-for="p in opened(service)" :key="p.port" class="no-drag btn btn-sm" :class="service.url ? 'btn-ghost' : 'btn-primary'" @click="api.openUrl(`http://localhost:${p.port}`)">{{ service.url ? '' : 'Open ' }}localhost:{{ p.port }}</button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="mx-auto max-w-4xl space-y-4 p-5">
            <div class="card">
              <div class="card-body gap-3">
                <h2>Service</h2>
                <dl class="selectable grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt class="opacity-60">Type</dt><dd>{{ service.type }}</dd>
                  <dt class="opacity-60">Cluster IP</dt><dd class="font-mono text-xs leading-5">{{ service.clusterIP ?? '—' }}</dd>
                  <template v-if="service.url"><dt class="opacity-60">Address</dt><dd class="min-w-0 truncate"><a class="link link-primary font-mono text-xs" @click.prevent="api.openUrl(service.url)">{{ service.url.replace(/^https?:\/\//, '') }}</a></dd></template>
                  <dt class="opacity-60">Created</dt><dd>{{ since(service.created) }}</dd>
                </dl>
                <table class="table table-sm">
                  <thead><tr><th>Port</th><th>To the pods</th><th>Node port</th><th>On this computer</th></tr></thead>
                  <tbody>
                    <tr v-for="p in service.ports" :key="p.port + p.protocol">
                      <td class="font-mono text-xs">{{ p.port }}/{{ p.protocol.toLowerCase() }}<span v-if="p.name" class="opacity-50"> {{ p.name }}</span></td>
                      <td class="font-mono text-xs">{{ p.targetPort }}</td>
                      <td class="font-mono text-xs">{{ p.nodePort ?? '—' }}</td>
                      <td class="text-xs">
                        <a v-if="service.type === 'LoadBalancer' && s?.published.includes(p.port)" class="link link-primary font-mono" @click.prevent="api.openUrl(`http://localhost:${p.port}`)">localhost:{{ p.port }}</a>
                        <span v-else-if="service.type === 'LoadBalancer'" class="opacity-50">opening…</span>
                        <span v-else class="opacity-50">inside the cluster only</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="service.type !== 'LoadBalancer'" class="text-xs opacity-55">Only a Service of type <span class="font-mono">LoadBalancer</span> opens on this computer: <span class="selectable font-mono">kubectl expose … --type=LoadBalancer</span>, or <span class="selectable font-mono">kubectl port-forward</span>.</p>
                <p v-if="s?.publishError" class="text-xs text-warning">{{ s.publishError }}</p>
              </div>
            </div>
            <div class="card">
              <div class="card-body gap-2">
                <h2>Pods it sends to</h2>
                <p v-if="!Object.keys(service.selector).length" class="text-sm opacity-60">No selector: this Service is not tied to pods.</p>
                <template v-else>
                  <div class="flex flex-wrap gap-1.5">
                    <span v-for="(v, k) in service.selector" :key="k" class="rounded-md bg-base-200/70 px-2 py-0.5 font-mono text-[11px]">{{ k }}=<span class="opacity-70">{{ v }}</span></span>
                  </div>
                  <ul class="space-y-1">
                    <li v-for="p in podsOf(service.selector, service.namespace)" :key="p.name">
                      <button class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-base-300/40" @click="pick('pod', p)">
                        <span class="status status-xs" :class="podDot(p.status)" /><span class="flex-1 truncate">{{ p.name }}</span><span class="text-xs opacity-55">{{ p.status }} · {{ p.ip ?? '—' }}</span>
                      </button>
                    </li>
                    <li v-if="!podsOf(service.selector, service.namespace).length" class="px-2 text-sm opacity-60">No pod matches yet.</li>
                  </ul>
                </template>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- a deployment -->
      <template v-else-if="deployment">
        <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl border border-base-300/70 bg-base-100" :class="INK"><svg viewBox="0 0 20 20" class="size-5" fill="currentColor"><path :d="ICON.deployment" /></svg></span>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-semibold tracking-tight">{{ deployment.name }}</h1>
            <p class="flex items-center gap-1.5 truncate text-xs opacity-60"><span class="status status-xs" :class="depDot(deployment) || 'bg-base-content/30'" />{{ deployment.ready }}/{{ deployment.replicas }} ready · {{ deployment.namespace }}</p>
          </div>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="mx-auto max-w-4xl space-y-4 p-5">
            <div class="card">
              <div class="card-body gap-2">
                <h2>Deployment</h2>
                <dl class="selectable grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt class="opacity-60">Replicas</dt><dd>{{ deployment.ready }} ready of {{ deployment.replicas }}</dd>
                  <dt class="opacity-60">Image</dt><dd class="font-mono text-xs leading-5 break-all">{{ deployment.images.join(', ') || '—' }}</dd>
                  <dt class="opacity-60">Created</dt><dd>{{ new Date(deployment.created).toLocaleString() }} · {{ since(deployment.created) }}</dd>
                </dl>
              </div>
            </div>
            <div class="card">
              <div class="card-body gap-2">
                <h2>Pods</h2>
                <ul class="space-y-1">
                  <li v-for="p in podsOf(deployment.selector, deployment.namespace)" :key="p.name">
                    <button class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-base-300/40" @click="pick('pod', p)">
                      <span class="status status-xs" :class="podDot(p.status)" /><span class="flex-1 truncate">{{ p.name }}</span><span class="text-xs opacity-55">{{ p.status }} · {{ since(p.created) }}</span>
                    </button>
                  </li>
                  <li v-if="!podsOf(deployment.selector, deployment.namespace).length" class="px-2 text-sm opacity-60">No pods yet.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- the cluster -->
      <template v-else>
        <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12" :class="INK"><svg viewBox="0 0 20 20" class="size-6" fill="currentColor"><path :d="WHEEL" /></svg></span>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-base font-semibold tracking-tight">Local cluster</h1>
            <p class="truncate text-xs opacity-60">
              <template v-if="!s">…</template>
              <template v-else-if="s.status === 'starting' || s.status === 'stopping'">{{ s.detail }}</template>
              <template v-else>k3s {{ s.version }} · {{ STATUS[s.status] }}<template v-if="s.node"> · node {{ s.node }}</template></template>
            </p>
          </div>
          <template v-if="s">
            <button v-if="s.status === 'running'" class="no-drag btn btn-sm" :disabled="!!busy" @click="run('stop', () => api.k8sStop())"><span v-if="busy === 'stop'" class="loading loading-spinner loading-xs" />Stop</button>
            <button v-else-if="s.status === 'off' || s.status === 'stopped'" class="no-drag btn btn-primary btn-sm" :disabled="!!busy" @click="run('start', () => api.k8sStart())">
              <span v-if="busy === 'start'" class="loading loading-spinner loading-xs" />{{ s.status === 'off' ? 'Turn on Kubernetes' : 'Start' }}
            </button>
            <span v-else class="loading loading-spinner loading-sm" />
          </template>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="!s" class="grid h-40 place-items-center"><span class="loading loading-spinner" /></div>
          <div v-else class="mx-auto max-w-4xl space-y-4 p-5">
            <TaskSteps v-if="s.task" :task="s.task" />
            <p v-else-if="s.error" role="alert" class="alert alert-error alert-soft selectable text-sm">{{ s.error }}</p>

            <!-- off: what it is -->
            <div v-if="s.status === 'off' && !s.task" class="card">
              <div class="card-body gap-3">
                <h2>A Kubernetes cluster on this computer</h2>
                <ul class="space-y-2 text-sm">
                  <li class="flex gap-2.5"><span class="mt-0.5" :class="INK">●</span><span>One node (k3s) on DoCatz’s engine — Standard or Lite, nothing else to install.</span></li>
                  <li class="flex gap-2.5"><span class="mt-0.5" :class="INK">●</span><span>Its pods are containers of the same Docker: an image from <span class="font-mono text-xs">docker build</span> runs at once, no registry.</span></li>
                  <li class="flex gap-2.5"><span class="mt-0.5" :class="INK">●</span><span>A Service of type <span class="font-mono text-xs">LoadBalancer</span> opens on <span class="font-mono text-xs">localhost</span> at its own port, and at <span class="font-mono text-xs">&lt;name&gt;.&lt;namespace&gt;.k8s.docatz.{{ s?.tld ?? 'localhost' }}</span>.</span></li>
                  <li class="flex gap-2.5"><span class="mt-0.5 opacity-50">●</span><span class="opacity-70">About 500 MB of memory while it is on, and a download of about 90 MB the first time. Off again any time.</span></li>
                </ul>
              </div>
            </div>

            <!-- running: at a glance -->
            <div v-if="s.status === 'running' && w" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div v-for="t in TILES" :key="t.label" class="rounded-box border border-base-300/60 bg-base-100 px-4 py-3">
                <div class="text-xl font-semibold tabular-nums tracking-tight">{{ t.value }}</div>
                <div class="text-xs opacity-60">{{ t.label }}</div>
              </div>
            </div>

            <div v-if="s.status === 'running'" class="card">
              <div class="card-body gap-2">
                <h2>kubectl</h2>
                <p class="text-sm opacity-70">
                  The cluster’s kubeconfig is <span class="selectable font-mono text-xs">{{ s.kubeconfig }}</span>, context <span class="font-mono text-xs">docatz</span>.
                  <span v-if="s.context" class="text-success">It is your current context.</span>
                </p>
                <pre class="selectable overflow-x-auto rounded-lg bg-base-200/70 px-3 py-2 font-mono text-xs leading-relaxed">{{ useContext }}</pre>
                <div class="flex flex-wrap items-center gap-2">
                  <button class="btn btn-sm" @click="api.copyText(useContext).then(() => notify('success', 'Copied'))">Copy</button>
                  <button class="btn btn-ghost btn-sm" @click="api.reveal(s.kubeconfig)">Show the file</button>
                  <span class="flex-1" />
                  <span v-if="s.kubectl" class="text-xs opacity-60">kubectl is in DoCatz’s bin folder, next to docker.</span>
                  <button v-else class="btn btn-sm" :disabled="!!busy" title="Downloads kubectl (about 55 MB) into DoCatz’s bin folder, next to docker" @click="run('kubectl', () => api.k8sInstallKubectl())">
                    <span v-if="busy === 'kubectl'" class="loading loading-spinner loading-xs" />{{ busy === 'kubectl' && s.detail ? s.detail : 'Install kubectl' }}
                  </button>
                </div>
                <p class="text-xs opacity-55">DoCatz never changes your own ~/.kube/config. An image built here is used with <span class="font-mono">imagePullPolicy: Never</span> (or <span class="font-mono">IfNotPresent</span>).</p>
              </div>
            </div>

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
      </template>
    </section>
  </div>
</template>
