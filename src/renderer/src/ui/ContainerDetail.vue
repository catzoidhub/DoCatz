<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcContainer, DcContainerDetail, DcStats } from '@shared/types';
import { api, attempt, bytes, changes, containerTab, errorText, notify, openContainer, statsHistory, type ContainerTab } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import DcNavButtons from './DcNavButtons.vue';
import LogsPane from './LogsPane.vue';
import TermPane from './TermPane.vue';
import FilesPane from './FilesPane.vue';
import ServiceMark from './ServiceMark.vue';
import TimeChart from './TimeChart.vue';

/**
 * One container (DoCatz TODO #12 / #13 / #15): its actions, and tabs — Info (image, command, ports, domain, mounts,
 * networks, environment names), Logs, Terminal, Files and Stats.
 */
const props = defineProps<{ container: DcContainer; stats: DcStats | null }>();
const c = computed(() => props.container);
const detail = ref<DcContainerDetail | null>(null);
const TABS: { id: ContainerTab; label: string }[] = [
  { id: 'info', label: 'Info' },
  { id: 'logs', label: 'Logs' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'stats', label: 'Stats' },
];

async function load() {
  try {
    detail.value = await api.container(c.value.id);
  } catch (e) {
    notify('error', errorText(e));
  }
}
watch([() => c.value.id, () => c.value.state, changes], load, { immediate: true });

const busy = ref('');
async function act(action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill') {
  busy.value = action;
  await attempt(() => api.containerAction(c.value.id, action));
  busy.value = '';
}
const removing = ref(false);
const removeVolumes = ref(false);
async function remove() {
  busy.value = 'remove';
  const ok = await attempt(() => api.containerRemove(c.value.id, removeVolumes.value), `${c.value.name} removed`);
  busy.value = '';
  removing.value = false;
  if (ok !== undefined) openContainer.value = null;
}

// Environment values are shown only on request: they are often secrets.
const env = ref<Record<string, string> | null>(null);
async function showEnv() {
  env.value = (await attempt(() => api.containerEnv(c.value.id))) ?? null;
}
watch(() => c.value.id, () => (env.value = null));

const copy = (text: string, what: string) => {
  void navigator.clipboard.writeText(text);
  notify('success', `${what} copied`);
};
const running = computed(() => c.value.state === 'running');

// The domain's name (before .docatz.<tld>): editable, the ending stays as Settings → Domains says.
const editingName = ref(false);
const nameInput = ref('');
const suffix = computed(() => (c.value.url ? new URL(c.value.url).hostname.replace(/^.*?\.(docatz\.)/, '$1') : 'docatz.localhost'));
const currentName = computed(() => (c.value.url ? new URL(c.value.url).hostname.slice(0, -(suffix.value.length + 1)) : ''));
function startName() {
  nameInput.value = currentName.value;
  editingName.value = true;
}
async function saveName() {
  const ok = await attempt(() => api.setDomainName(c.value.domainKey, nameInput.value.trim() || null));
  if (ok !== undefined) {
    editingName.value = false;
    notify('success', nameInput.value.trim() ? `Now at ${nameInput.value.trim()}.${suffix.value}` : 'Back to the default name');
  }
}
const history = computed(() => statsHistory.value[c.value.id] ?? []);
const memPct = computed(() => (props.stats && props.stats.memLimit ? (props.stats.memUsed / props.stats.memLimit) * 100 : 0));
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="drag win-top flex h-14 shrink-0 items-end gap-3 border-b border-base-300/60 px-4 pb-2">
      <div class="no-drag"><DcNavButtons /></div>
      <ServiceMark :container="c" size="lg" class="mb-0.5" />
      <div class="min-w-[10rem] flex-1 pb-0.5">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="min-w-0 truncate text-base font-semibold tracking-tight" :title="c.name">{{ c.name }}</h1>
          <span class="badge badge-sm shrink-0" :class="running ? 'badge-success badge-soft' : 'badge-ghost'">{{ c.state }}</span>
          <span v-if="c.health" class="badge badge-sm badge-soft shrink-0" :class="c.health === 'healthy' ? 'badge-success' : c.health === 'unhealthy' ? 'badge-error' : 'badge-warning'">{{ c.health }}</span>
        </div>
        <p class="flex min-w-0 items-center gap-1.5 text-xs">
          <span class="truncate opacity-55">{{ c.image }} · {{ c.status }}</span>
          <template v-if="c.url && running">
            <span class="shrink-0 opacity-30">·</span>
            <a class="no-drag link link-hover min-w-0 truncate font-mono text-primary" :title="`Open ${c.url}`" @click="api.openUrl(c.url)">{{ c.url.replace(/^https?:\/\//, '') }}</a>
          </template>
          <template v-else-if="c.inner">
            <span class="shrink-0 opacity-30">·</span>
            <span class="min-w-0 truncate font-mono opacity-70" title="Not a web page: the other services of its project reach it at this address">{{ c.inner }}</span>
          </template>
        </p>
      </div>
      <div class="no-drag flex shrink-0 items-center gap-1">
        <span v-if="busy" class="loading loading-spinner loading-sm mx-2" />
        <template v-else>
          <button v-if="running" class="btn btn-sm" @click="act('stop')">Stop</button>
          <button v-else class="btn btn-sm btn-primary" @click="act('start')">Start</button>
          <button class="btn btn-sm" @click="act('restart')">Restart</button>
          <button v-if="running" class="btn btn-ghost btn-sm" @click="act('pause')">Pause</button>
          <button v-if="c.state === 'paused'" class="btn btn-ghost btn-sm" @click="act('unpause')">Resume</button>
          <button class="btn btn-ghost btn-sm btn-square text-error" title="Remove the container" @click="removing = true">
            <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.44c-.8.08-1.59.18-2.38.3a.75.75 0 1 0 .23 1.48l.15-.02.84 10.52A2.75 2.75 0 0 0 7.58 19h4.84a2.75 2.75 0 0 0 2.74-2.53l.84-10.52.15.02a.75.75 0 0 0 .23-1.48c-.79-.12-1.58-.22-2.38-.3v-.44A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.67.02 2.5.07v-.32c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.32C8.33 4.02 9.16 4 10 4Z" clip-rule="evenodd" /></svg>
          </button>
        </template>
      </div>
    </header>
    <div class="flex shrink-0 items-center gap-1 border-b border-base-300/60 px-4 py-1.5">
      <div role="tablist" class="seg">
        <a v-for="t in TABS" :key="t.id" role="tab" class="seg-item" :class="{ 'is-active': containerTab === t.id }" @click="containerTab = t.id">{{ t.label }}</a>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <!-- Info -->
      <div v-if="containerTab === 'info'" class="h-full overflow-y-auto">
        <div v-if="!detail" class="grid h-40 place-items-center"><span class="loading loading-spinner" /></div>
        <div v-else class="mx-auto max-w-3xl space-y-4 p-5">
          <div class="card">
            <div class="card-body gap-2">
              <h2>Container</h2>
              <dl class="selectable grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt class="opacity-60">Image</dt><dd class="font-mono text-xs leading-5 break-all">{{ detail.image }} <span class="opacity-50">({{ detail.platform }})</span></dd>
                <template v-if="detail.project"><dt class="opacity-60">Compose</dt><dd>{{ detail.project }} / {{ detail.service }} <a v-if="detail.workingDir" class="link text-xs opacity-70" @click="api.reveal(detail.workingDir)">{{ detail.workingDir }}</a></dd></template>
                <dt class="opacity-60">Command</dt><dd class="font-mono text-xs leading-5 break-all">{{ [detail.entrypoint, detail.command].filter(Boolean).join(' ') || '—' }}</dd>
                <dt class="opacity-60">Restart policy</dt><dd>{{ detail.restartPolicy }}<template v-if="detail.restartCount"> · restarted {{ detail.restartCount }}×</template></dd>
                <template v-if="detail.exitCode !== null"><dt class="opacity-60">Exit code</dt><dd :class="{ 'text-error': detail.exitCode !== 0 }">{{ detail.exitCode }}</dd></template>
                <dt class="opacity-60">Started</dt><dd>{{ detail.startedAt && !detail.startedAt.startsWith('0001') ? new Date(detail.startedAt).toLocaleString() : '—' }}</dd>
                <dt class="opacity-60">ID</dt><dd class="font-mono text-xs leading-5"><a class="link-hover cursor-pointer" title="Copy" @click="copy(detail.id, 'ID')">{{ detail.id.slice(0, 12) }}</a></dd>
              </dl>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Ports and domain</h2>
              <p v-if="!detail.ports.length" class="text-sm opacity-60">This container publishes no port.</p>
              <ul v-else class="space-y-1 text-sm">
                <li v-for="p in detail.ports" :key="`${p.private}/${p.type}/${p.public}`" class="flex items-center gap-2">
                  <span class="font-mono text-xs">{{ p.private }}/{{ p.type }}</span>
                  <template v-if="p.public">
                    <span class="opacity-40">→</span>
                    <a class="link font-mono text-xs" @click="api.openUrl(`http://localhost:${p.public}`)">localhost:{{ p.public }}</a>
                  </template>
                  <span v-else class="text-xs opacity-50">not published</span>
                </li>
              </ul>
              <div v-if="detail.url" class="space-y-1.5 pt-1">
                <div v-if="!editingName" class="flex flex-wrap items-center gap-2">
                  <span class="text-sm opacity-60">Domain</span>
                  <a class="link font-mono text-xs" @click="api.openUrl(detail.url)">{{ detail.url }}</a>
                  <button class="btn btn-ghost btn-xs" @click="copy(detail.url, 'URL')">Copy</button>
                  <button class="btn btn-ghost btn-xs" title="Change the name in front of .docatz" @click="startName">Edit</button>
                  <span v-if="c.domainName" class="badge badge-ghost badge-xs">custom</span>
                </div>
                <form v-else class="flex flex-wrap items-center gap-1.5" @submit.prevent="saveName">
                  <span class="text-sm opacity-60">Domain</span>
                  <input v-model="nameInput" class="input input-sm w-56 font-mono text-xs" spellcheck="false" autofocus @keydown.esc.prevent="editingName = false" />
                  <span class="font-mono text-xs opacity-60">.{{ suffix }}</span>
                  <button class="btn btn-primary btn-xs">Save</button>
                  <button v-if="c.domainName" type="button" class="btn btn-ghost btn-xs" title="Back to the name DoCatz picks" @click="nameInput = ''; saveName()">Default</button>
                  <button type="button" class="btn btn-ghost btn-xs" @click="editingName = false">Cancel</button>
                </form>
                <p v-if="editingName" class="text-xs opacity-55">Letters, digits and dashes; dots make sub-names (api.shop). The ending .{{ suffix }} follows Settings → Domains.</p>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Mounts</h2>
              <p v-if="!detail.mounts.length" class="text-sm opacity-60">No volumes or folders mounted.</p>
              <ul v-else class="selectable space-y-1 text-xs">
                <li v-for="m in detail.mounts" :key="m.destination" class="flex items-center gap-2 font-mono">
                  <span class="badge badge-ghost badge-xs">{{ m.type }}</span>
                  <a v-if="m.type === 'bind'" class="link-hover cursor-pointer truncate" :title="m.source" @click="api.reveal(m.source)">{{ m.source }}</a>
                  <span v-else class="truncate">{{ m.source }}</span>
                  <span class="opacity-40">→</span><span class="truncate">{{ m.destination }}</span>
                  <span v-if="!m.rw" class="badge badge-ghost badge-xs">read-only</span>
                </li>
              </ul>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <h2>Networks</h2>
              <ul class="selectable space-y-1 text-sm">
                <li v-for="n in detail.ips" :key="n.network"><span class="font-medium">{{ n.network }}</span> <span class="font-mono text-xs opacity-60">{{ n.ip || '—' }}</span></li>
              </ul>
            </div>
          </div>
          <div class="card">
            <div class="card-body gap-2">
              <div class="flex items-center gap-2">
                <h2>Environment</h2>
                <span class="flex-1" />
                <button v-if="!env && detail.envNames.length" class="btn btn-ghost btn-xs" title="Values can be passwords and keys" @click="showEnv">Show values</button>
                <button v-else-if="env" class="btn btn-ghost btn-xs" @click="env = null">Hide values</button>
              </div>
              <p v-if="!detail.envNames.length" class="text-sm opacity-60">No environment variables.</p>
              <dl v-else class="selectable grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1 font-mono text-xs">
                <template v-for="n in detail.envNames" :key="n">
                  <dt class="opacity-70">{{ n }}</dt>
                  <dd class="break-all">{{ env ? env[n] : '•••' }}</dd>
                </template>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <LogsPane v-else-if="containerTab === 'logs'" :container="c" />
      <TermPane v-else-if="containerTab === 'terminal'" :container="c" />
      <FilesPane v-else-if="containerTab === 'files'" :container="c" />

      <!-- Stats -->
      <div v-else-if="containerTab === 'stats'" class="h-full overflow-y-auto p-5">
        <p v-if="!running" class="text-sm opacity-60">Stats show while the container runs.</p>
        <div v-else-if="!stats" class="grid h-40 place-items-center"><span class="loading loading-spinner" /></div>
        <div v-else class="mx-auto grid max-w-3xl gap-3 sm:grid-cols-2">
          <div class="card"><div class="card-body gap-1"><span class="label-caps">CPU</span><span class="text-2xl font-semibold tabular-nums">{{ stats.cpu.toFixed(1) }}%</span><span class="text-xs opacity-55">of one core = 100%</span></div></div>
          <div class="card"><div class="card-body gap-1"><span class="label-caps">Memory</span><span class="text-2xl font-semibold tabular-nums">{{ bytes(stats.memUsed) }}</span><progress class="progress progress-primary h-1.5" :value="memPct" max="100" /><span class="text-xs opacity-55">of {{ bytes(stats.memLimit) }}</span></div></div>
          <div class="card"><div class="card-body gap-1"><span class="label-caps">Network</span><span class="text-sm tabular-nums">↓ {{ bytes(stats.netRx) }} · ↑ {{ bytes(stats.netTx) }}</span><span class="text-xs opacity-55">since the container started</span></div></div>
          <div class="card"><div class="card-body gap-1"><span class="label-caps">Disk I/O</span><span class="text-sm tabular-nums">read {{ bytes(stats.blockRead) }} · written {{ bytes(stats.blockWrite) }}</span><span class="text-xs opacity-55">{{ stats.pids }} processes</span></div></div>
          <div class="card sm:col-span-2"><div class="card-body gap-2"><div class="flex items-baseline gap-2"><h2 class="flex-1">CPU</h2><span class="text-xs opacity-50">every 5 s, the last 10 minutes</span></div><TimeChart :series="[{ name: 'CPU', color: 'oklch(70% 0.14 240)', points: history.map((h) => ({ t: h.t, v: h.cpu })) }]" :format="(v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`" :min-max="5" :height="150" /></div></div>
          <div class="card sm:col-span-2"><div class="card-body gap-2"><h2>Memory</h2><TimeChart :series="[{ name: 'Memory', color: 'oklch(64% 0.17 280)', points: history.map((h) => ({ t: h.t, v: h.mem })) }]" :format="bytes" :min-max="32 * 1024 * 1024" :height="150" /></div></div>
        </div>
      </div>
    </div>

    <ConfirmDialog v-if="removing" :title="`Remove ${c.name}?`" text="The container and its own files go. Images stay; named volumes stay unless you tick the box." confirm="Remove" tone="error" :busy="busy === 'remove'" @cancel="removing = false" @ok="remove">
      <label class="flex cursor-pointer items-center gap-2 text-sm"><input v-model="removeVolumes" type="checkbox" class="checkbox checkbox-sm" />Also remove its anonymous volumes</label>
    </ConfirmDialog>
  </section>
</template>
