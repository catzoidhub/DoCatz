<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcDiskUsage, DcMigrateSource, DcPruneKind, DcWslMemory, EngineConfig } from '@shared/types';
import { words } from '@shared/platform';
import { api, attempt, bytes, changes, engine, engineUp, notify } from '../store';
import CatMood from './CatMood.vue';
import DcNavButtons from './DcNavButtons.vue';
import PruneDialog from './PruneDialog.vue';
import TaskSteps from './TaskSteps.vue';
import WslSetup from './WslSetup.vue';
import CopyName from './CopyName.vue';
import MigrateDialog from './MigrateDialog.vue';
import { engineCards, engineRows } from './engines';

/**
 * Engine (DoCatz TODO #5 / #6 / #7): the VM's state and Start / Stop / Restart, its CPUs, memory, disk and Rosetta,
 * the docatz docker context, DoCatz's own CLIs and PATH, disk usage with clean-up, the engine log, and Reset.
 */
const s = computed(() => engine.value);
const c = computed(() => s.value?.config);
const isMac = computed(() => s.value?.backend === 'lima' || s.value?.backend === 'lite');
/** On a Mac the two engines are two VMs: Reset takes only the one in use (on Windows Lite is the same distro). */
const resetWhat = computed(() => (isMac.value ? (s.value?.backend === 'lite' ? { name: 'Lite', other: 'Standard' } : { name: 'Standard', other: 'Lite' }) : null));
const isWsl = computed(() => s.value?.backend === 'wsl');
/** Standard and Lite side by side (TODO #106): what each is, and DoCatz's own measured numbers (engines.ts). */
const ENGINES = computed(() => engineCards(isWsl.value));
const ENGINE_ROWS = computed(() => engineRows(isWsl.value));
/** Standard ⇄ Lite (TODO #106, beta): macOS, and on Windows the sleeping WSL engine. */
const canLite = computed(() => isMac.value || isWsl.value);
/** Linux (#101): the system's Docker Engine, no VM — no limits to set and no Reset. */
const isSystem = computed(() => s.value?.backend === 'system');
/** The engines DoCatz can move from on this platform (#103: said when none is there). */
const otherNames = computed(() => (isSystem.value ? 'Docker Desktop, Rancher Desktop, Colima or Podman' : s.value?.backend === 'wsl' ? 'Docker Desktop or Rancher Desktop' : 'Docker Desktop, OrbStack, Colima or Rancher Desktop'));
const busy = ref('');
/** The page in tabs under the state card. */
type Tab = 'overview' | 'settings' | 'cli' | 'move';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
  { id: 'cli', label: 'Docker CLI' },
  { id: 'move', label: 'Move from another Docker' },
];
/**
 * Which tab opens (user, 2026-11-21): Settings while the engine is not on — Standard or Lite and its resources are chosen
 * before it starts (or set up) — and Overview once it runs. A sleeping Lite engine counts as on.
 */
const on = computed(() => s.value?.status === 'running' || s.value?.status === 'sleeping');
const tab = ref<Tab>('overview');
watch(
  () => (s.value ? on.value : null),
  (now, was) => {
    if (now === null) return;
    if (was === undefined || was === null) tab.value = now ? 'overview' : 'settings';
    else if (now && !was) tab.value = 'overview';
  },
  { immediate: true },
);
const wslTask = computed(() => s.value?.task?.title === 'Installing WSL');
async function run(name: string, fn: () => Promise<unknown>, done?: string) {
  busy.value = name;
  await attempt(fn, done);
  busy.value = '';
}
/** Docker Desktop, OrbStack, Colima or Rancher Desktop on this computer (#11): looked at once the engine runs. */
const others = ref<DcMigrateSource[]>([]);
const moving = ref<DcMigrateSource | null>(null);
async function lookAgain() {
  others.value = await api.migrateSources().catch(() => []);
}
watch(engineUp, (up) => up && void lookAgain(), { immediate: true });
const STATUS: Record<string, string> = { running: 'Running', stopped: 'Stopped', starting: 'Starting…', stopping: 'Stopping…', missing: 'Not set up', error: 'Needs attention', unsupported: 'Not available', sleeping: 'Sleeping' };

// Windows: "Use less memory for WSL" (.wslconfig, WSL-wide; asked first in a dialog, then WSL restarts).
const wslMem = ref<DcWslMemory | null>(null);
const wslMemBusy = ref(false);
watch(isWsl, (w) => w && void api.wslMemory().then((m) => (wslMem.value = m)).catch(() => undefined), { immediate: true });
async function setWslMem(on: boolean) {
  wslMemBusy.value = true;
  const r = await attempt(() => api.wslMemorySet(on));
  wslMem.value = r ?? (await api.wslMemory().catch(() => wslMem.value));
  wslMemBusy.value = false;
}

async function set(patch: Partial<EngineConfig>) {
  const r = await attempt(() => api.engineConfigure(patch));
  // Not saved (a cancelled password prompt for on-demand Docker): the switches go back to what is saved.
  engine.value = r ?? (await api.engineState().catch(() => engine.value));
}

const df = ref<DcDiskUsage | null>(null);
watch(
  [engineUp, changes],
  async () => {
    df.value = engineUp.value ? await api.diskUsage().catch(() => null) : null;
  },
  { immediate: true },
);
const pruning = ref<DcPruneKind | null>(null);

const log = ref<string | null>(null);
async function showLog() {
  log.value = (await attempt(() => api.engineLog())) ?? null;
}
const resetting = ref(false);
const resetTyped = ref('');
async function reset() {
  resetting.value = false;
  await run('reset', () => api.engineReset(resetTyped.value), 'The engine was reset');
  resetTyped.value = '';
}
const copy = (t: string) => {
  void navigator.clipboard.writeText(t);
  notify('success', 'Copied');
};
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="drag win-top flex h-20 shrink-0 items-center gap-3 border-b border-base-300/60 px-4">
      <div class="no-drag"><DcNavButtons /></div>
      <h1 class="text-base font-semibold tracking-tight">Engine</h1>
    </header>
    <div v-if="s && c" class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-2xl space-y-4 px-6 py-6">
        <!-- Windows: what the engine stands on — first, as the engine starts only once both are on -->
        <div v-if="s.backend === 'wsl'" class="card" :class="s.needs && 'ring-1 ring-primary/40'">
          <div class="card-body gap-3">
            <h2>{{ s.needs ? 'First · Windows Subsystem for Linux' : 'Windows Subsystem for Linux' }}</h2>
            <p v-if="s.needs" class="text-sm opacity-70">The engine runs in WSL 2, Windows’ own Linux, which needs virtualisation on in the PC. It can start once both are on:</p>
            <WslSetup />
            <p v-if="s.prereqs?.wsl" class="text-xs opacity-60">
              DoCatz’s Linux is its own WSL distro, <span class="font-mono">docatz</span>, kept in {{ s.vm?.dir || '%USERPROFILE%\\.docatz\\vm\\wsl' }}.
            </p>
          </div>
        </div>

        <!-- state -->
        <div class="card">
          <div class="card-body gap-3">
            <div class="flex items-center gap-3">
              <span class="status status-lg" :class="s.status === 'running' ? 'status-success' : s.status === 'error' ? 'status-error' : s.status === 'starting' || s.status === 'stopping' ? 'status-warning' : ''" />
              <div class="min-w-0 flex-1">
                <h2 class="text-base">{{ STATUS[s.status] ?? s.status }}</h2>
                <p class="text-xs opacity-60">{{ s.docker ? `Docker ${s.docker.version} · ${s.docker.os} · ${s.docker.cpus} CPUs · ${bytes(s.docker.memory)}` : s.status === 'sleeping' ? s.message : s.vm?.manager }}</p>
              </div>
              <template v-if="s.status === 'running'">
                <button class="btn btn-sm" :disabled="!!busy" @click="run('restart', () => api.engineRestart())"><span v-if="busy === 'restart'" class="loading loading-spinner loading-xs" />Restart</button>
                <button class="btn btn-sm" :disabled="!!busy" @click="run('stop', () => api.engineStop())"><span v-if="busy === 'stop'" class="loading loading-spinner loading-xs" />Stop</button>
              </template>
              <button v-else-if="!['unsupported', 'starting', 'stopping'].includes(s.status) && (!s.task || s.task.error)" class="btn btn-primary btn-sm" @click="run('start', () => api.engineStart())">{{ s.status === 'missing' ? (isSystem ? 'Install Docker Engine' : 'Set up and start') : s.task?.error ? 'Try again' : 'Start' }}</button>
              <button v-else-if="s.task && !s.task.error && !wslTask" class="btn btn-ghost btn-sm" @click="api.engineCancel()">Cancel</button>
            </div>
            <!-- WSL's own install shows in the card above -->
            <p v-if="s.needs" class="text-sm opacity-70">The engine starts once WSL is ready (above).</p>
            <p v-else-if="s.message && s.status !== 'running'" class="text-sm opacity-70">{{ s.message }}</p>
            <TaskSteps v-if="s.task && !wslTask" :task="s.task" />
            <div v-if="s.task?.error && !wslTask" role="alert" class="alert alert-error alert-soft text-sm">
              <CatMood mood="error" class="-my-1 size-8 shrink-0" />
              <span class="selectable">{{ s.task.error }}</span>
              <button class="btn btn-ghost btn-xs" @click="showLog">Engine log</button>
            </div>
            <div v-if="s.pending.length" role="alert" class="alert alert-warning alert-soft text-sm">
              <span>Restart the engine to apply: {{ s.pending.join(', ') }}.</span>
              <button class="btn btn-sm" :disabled="!!busy" @click="run('restart', () => api.engineRestart())">Restart now</button>
            </div>
          </div>
        </div>

        <!-- the rest in tabs (user, 2026-11-18: the page ran too long): what it is, its settings, the CLIs, moving in -->
        <div class="seg w-full">
          <button v-for="t in TABS" :key="t.id" class="seg-item flex-1 justify-center text-center normal-case" :class="{ 'is-active': tab === t.id }" @click="tab = t.id">{{ t.label }}</button>
        </div>
        <!-- engine choice (TODO #106) -->
        <div v-if="canLite && c" v-show="tab === 'settings'" class="card">
          <div class="card-body gap-3">
            <h2>Standard or Lite</h2>
            <!-- Two cards (user, 2026-11-18: a segmented switch did not read as a choice): what each is, DoCatz's own
                 numbers (an Apple M4, CatzTodo/DoCatz/measurements.md), "In use" on one and a button on the other. -->
            <div class="grid gap-3 sm:grid-cols-2">
              <div
                v-for="e in ENGINES"
                :key="e.kind"
                class="flex flex-col gap-3 rounded-box border p-4 transition-colors"
                :class="(c.kind ?? 'standard') === e.kind ? 'border-primary/60 bg-primary/8 ring-1 ring-primary/30' : 'border-base-300/70 bg-base-100'"
              >
                <div class="flex items-start gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-base font-semibold tracking-tight">{{ e.name }}</span>
                      <span v-if="e.kind === 'lite'" class="badge badge-xs badge-soft badge-warning">beta</span>
                    </div>
                    <p class="mt-0.5 text-xs leading-relaxed opacity-65">{{ e.about }}</p>
                  </div>
                  <span v-if="(c.kind ?? 'standard') === e.kind" class="badge badge-sm badge-primary shrink-0 gap-1">
                    <svg viewBox="0 0 20 20" class="size-3" fill="currentColor"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.8 6.8-6.8a1 1 0 0 1 1.4 0Z" clip-rule="evenodd" /></svg>
                    {{ s.status === 'missing' ? 'Chosen' : 'In use' }}
                  </span>
                </div>
                <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <template v-for="row in ENGINE_ROWS" :key="row[0]">
                    <dt class="opacity-55">{{ row[0] }}</dt>
                    <dd class="font-medium">{{ e.kind === 'lite' ? row[2] : row[1] }}</dd>
                  </template>
                </dl>
                <div class="mt-auto pt-1">
                  <button
                    v-if="(c.kind ?? 'standard') !== e.kind"
                    class="btn btn-sm w-full"
                    :class="e.kind === 'lite' ? 'btn-primary' : ''"
                    :disabled="!!busy"
                    @click="set({ kind: e.kind })"
                  >
                    {{ s.status === 'missing' ? `Use ${e.name}` : `Switch to ${e.name}` }}
                  </button>
                  <p v-else class="text-center text-xs opacity-55">{{ s.status === 'missing' ? 'Set up and start (above) sets this one up' : 'The engine DoCatz runs now' }}</p>
                </div>
              </div>
            </div>
            <p v-if="isWsl" class="text-xs opacity-60">Measured on a Ryzen 5 3600 PC with WSL’s default settings; yours will differ. Both use the same engine and disk, so nothing moves; DoCatz restarts once to switch. WSL’s VM gives its memory back only when no other WSL distro is running.</p>
            <p v-else class="text-xs opacity-60">Measured on an Apple M4 with 4 CPUs and 4 GB for the VM; yours will differ. Each engine keeps its own containers, images and volumes; switching stops one and starts the other, and DoCatz restarts once. Move from another Docker brings images and volumes across.</p>
          </div>
        </div>

        <!-- resources -->
        <div v-show="tab === 'settings'" class="card">
          <div class="card-body gap-3">
            <h2>Resources</h2>
            <template v-if="isMac">
              <label class="grid grid-cols-[7rem_1fr_4rem] items-center gap-3">
                <span>CPUs</span>
                <input type="range" class="range range-primary range-xs" min="1" :max="s.host.cpus" :value="c.cpus" @change="set({ cpus: Number(($event.target as HTMLInputElement).value) })" />
                <span class="text-right tabular-nums">{{ c.cpus }} of {{ s.host.cpus }}</span>
              </label>
              <label class="grid grid-cols-[7rem_1fr_4rem] items-center gap-3">
                <span>Memory</span>
                <input type="range" class="range range-primary range-xs" min="1" :max="Math.max(2, s.host.memoryGiB - 2)" :value="c.memoryGiB" @change="set({ memoryGiB: Number(($event.target as HTMLInputElement).value) })" />
                <span class="text-right tabular-nums">{{ c.memoryGiB }} GB</span>
              </label>
              <label class="grid grid-cols-[7rem_1fr_4rem] items-center gap-3">
                <span>Disk</span>
                <input type="range" :key="s.diskMinGiB" class="range range-primary range-xs" :min="s.diskMinGiB" max="512" step="8" :value="c.diskGiB" @change="set({ diskGiB: Number(($event.target as HTMLInputElement).value) })" />
                <span class="text-right tabular-nums">{{ c.diskGiB }} GB</span>
              </label>
              <p class="text-xs opacity-60">The disk is the most it may grow to; it only takes what is used<template v-if="s.vm?.diskBytes"> (now {{ bytes(s.vm.diskBytes) }})</template>. It can grow later but not shrink.</p>
              <label v-if="s.host.rosetta" class="opt-row cursor-pointer">
                <span class="flex flex-col"><span class="label-caps">Rosetta for Intel images</span><span class="text-xs opacity-50">Runs linux/amd64 images fast on Apple silicon.</span></span>
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="c.rosetta" @change="set({ rosetta: ($event.target as HTMLInputElement).checked })" />
              </label>
            </template>
            <p v-else-if="isSystem" class="text-sm opacity-70">Docker Engine runs on {{ words.thisComputer }} itself, with no VM in between: containers use its CPUs, memory and disk directly, so there are no limits to set here.</p>
            <!-- Linux's lighter option (TODO #106): the system's Docker only while it is used. -->
            <label v-if="isSystem" class="opt-row cursor-pointer">
              <span class="flex flex-col">
                <span class="label-caps">Start Docker only when it is used</span>
                <span class="text-xs opacity-50">Docker Engine no longer starts with {{ words.thisComputer }}: the first docker command, DevCatz or DoCatz starts it in about a second, and DoCatz stops it after 15 minutes with no containers running — about 100 MB back while you do not use it. Changes the system’s Docker setup: your password, once.</span>
              </span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="c.onDemand" :disabled="!!busy" @change="set({ onDemand: ($event.target as HTMLInputElement).checked })" />
            </label>
            <p v-else class="text-sm opacity-70">WSL 2 shares one set of limits between every distro: set them in <span class="font-mono">%USERPROFILE%\.wslconfig</span> (memory, processors), then restart the engine.</p>
            <label v-if="isWsl && wslMem" class="opt-row cursor-pointer">
              <span class="flex flex-col">
                <span class="label-caps">Use less memory for WSL</span>
                <span class="text-xs opacity-50">Turns off Linux apps with windows (WSLg) and gives memory Linux no longer uses back to Windows — about 1.4 GB down to about 650 MB on DoCatz’s test PC. For every WSL distro on this PC; WSL restarts once.<template v-if="!wslMem.on && (!wslMem.gui || wslMem.reclaim !== 'disabled')"> Now: WSLg {{ wslMem.gui ? 'on' : 'off' }}, memory reclaim {{ wslMem.reclaim }}.</template></span>
              </span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="wslMem.on" :disabled="!!busy || wslMemBusy" @change="setWslMem(($event.target as HTMLInputElement).checked)" />
            </label>
            <label class="opt-row cursor-pointer">
              <span class="flex flex-col"><span class="label-caps">Start with DoCatz</span><span class="text-xs opacity-50">Starts the engine when DoCatz opens.</span></span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="c.autoStart" @change="set({ autoStart: ($event.target as HTMLInputElement).checked })" />
            </label>
            <label class="opt-row cursor-pointer">
              <span class="flex flex-col">
                <span class="label-caps">Keep the engine running after DoCatz quits <span class="badge badge-xs badge-soft badge-warning ml-1 align-middle normal-case tracking-normal">beta</span></span>
                <span class="text-xs opacity-50">A small background helper keeps the engine, container domains and database ports going with DoCatz closed, and starts them when you log in. DoCatz restarts once to switch.</span>
              </span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="c.keepRunning" @change="set({ keepRunning: ($event.target as HTMLInputElement).checked })" />
            </label>
          </div>
        </div>

        <!-- docker context and CLIs -->
        <div v-show="tab === 'cli'" class="card">
          <div class="card-body gap-3">
            <h2>Docker command line</h2>
            <div class="opt-row">
              <span class="flex min-w-0 flex-col">
                <span class="label-caps">Use DoCatz as the default</span>
                <span class="text-xs opacity-50">
                  Makes the <span class="font-mono">docatz</span> context the current one, so <span class="font-mono">docker</span> in any terminal talks to DoCatz.
                  Now: <span class="font-mono">{{ s.context.currentName }}</span>.<template v-if="!s.context.current"> Without it: <span class="font-mono">docker --context docatz …</span></template>
                </span>
              </span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.context.current" @change="attempt(() => api.contextSet(($event.target as HTMLInputElement).checked)).then((r) => r && (engine = r))" />
            </div>
            <div class="opt-row">
              <span class="flex min-w-0 flex-col">
                <span class="label-caps">docker, compose and buildx</span>
                <span class="text-xs opacity-50">
                  <template v-if="s.cli.installed">Docker CLI {{ s.cli.version }} in <a class="link font-mono" @click="api.reveal(s.cli.dir)">{{ s.cli.dir }}</a>.</template>
                  <template v-else>Not installed yet — the first engine start installs them.</template>
                  <template v-if="s.cli.otherDocker"> Your own docker ({{ s.cli.otherDocker }}) keeps working.</template>
                </span>
              </span>
              <button v-if="!s.cli.installed" class="btn btn-sm" :disabled="!!s.task" @click="attempt(() => api.cliInstall())">Install</button>
            </div>
            <div v-if="s.cli.installed" class="opt-row">
              <span class="flex min-w-0 flex-col">
                <span class="label-caps">Add to PATH</span>
                <span class="text-xs opacity-50">{{ isMac ? 'New terminals find DoCatz’s docker first (a line in .zprofile).' : isSystem ? 'New terminals find DoCatz’s docker first (a line in .bashrc).' : 'New terminals find DoCatz’s docker (your user Path).' }}{{ s.cli.otherDocker ? ' Leave it off to keep using your own docker binary — the context is enough.' : '' }}</span>
              </span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.cli.inPath" @change="attempt(() => api.cliPath(($event.target as HTMLInputElement).checked)).then((r) => r && (engine = r))" />
            </div>
            <div class="flex items-center gap-2 text-xs">
              <span class="opacity-60">DOCKER_HOST</span>
              <code class="selectable min-w-0 flex-1 truncate rounded bg-base-200/70 px-2 py-1">{{ s.dockerHost }}</code>
              <button class="btn btn-ghost btn-xs" @click="copy(`export DOCKER_HOST=${s.dockerHost}`)">Copy</button>
            </div>
          </div>
        </div>

        <!-- disk usage -->
        <div v-if="df" v-show="tab === 'overview'" class="card">
          <div class="card-body gap-2">
            <h2>Disk usage</h2>
            <table class="table table-sm">
              <thead><tr><th>What</th><th class="text-right">Count</th><th class="text-right">Size</th><th class="text-right">Can be freed</th><th /></tr></thead>
              <tbody>
                <tr v-for="row in [{ k: 'images', label: 'Images', v: df.images }, { k: 'containers', label: 'Containers', v: df.containers }, { k: 'volumes', label: 'Volumes', v: df.volumes }, { k: 'build-cache', label: 'Build cache', v: df.buildCache }] as const" :key="row.k">
                  <td>{{ row.label }}</td>
                  <td class="text-right tabular-nums">{{ row.v.count }}</td>
                  <td class="text-right tabular-nums">{{ bytes(row.v.size) }}</td>
                  <td class="text-right tabular-nums opacity-70">{{ bytes(row.v.reclaimable) }}</td>
                  <td class="text-right"><button class="btn btn-ghost btn-xs" :disabled="!row.v.reclaimable && row.k !== 'containers'" @click="pruning = row.k">Clean up…</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- move from another Docker (#11) -->
        <div v-show="tab === 'move'" class="card">
          <div class="card-body gap-2">
            <h2>Move from another Docker</h2>
            <p class="text-xs opacity-60">Copy images and volumes onto DoCatz’s engine. The other one keeps them, so both can stay side by side.</p>
            <!-- #103: an empty list says why, rather than hiding the card -->
            <p v-if="!others.length" class="text-sm opacity-70">
              <template v-if="isSystem">DoCatz uses this computer’s Docker Engine, so its images and volumes are already here.</template>
              <template v-else>No other Docker on this computer.</template>
              {{ otherNames }} appear here when installed.
              <button class="btn btn-ghost btn-xs ml-1" @click="lookAgain">Look again</button>
            </p>
            <ul class="divide-y divide-base-300/50">
              <li v-for="o in others" :key="o.id" class="flex items-center gap-3 py-2">
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-medium">{{ o.name }}</span>
                  <span class="block text-xs opacity-55">{{ o.own ? (o.running ? `Running · Docker ${o.version}` : 'Your other DoCatz engine — DoCatz starts it for the move, then stops it') : o.running ? `Running · Docker ${o.version}` : 'Installed, not running — start it to move from it' }}</span>
                  <span v-if="o.hint" class="selectable block font-mono text-[11px] opacity-55">{{ o.hint }}</span>
                </span>
                <button v-if="o.running || o.own" class="btn btn-sm" @click="moving = o">Choose what to move…</button>
                <button v-else class="btn btn-ghost btn-sm" @click="lookAgain">Look again</button>
              </li>
            </ul>
          </div>
        </div>

        <!-- details -->
        <div v-show="tab === 'overview'" class="card">
          <div class="card-body gap-2">
            <div class="flex items-center gap-2"><h2>Details</h2><span class="flex-1" /><button class="btn btn-ghost btn-xs" @click="showLog">Engine log</button></div>
            <dl class="selectable grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt class="opacity-60">{{ isSystem ? 'Engine' : 'VM' }}</dt><dd>{{ s.vm?.manager ?? '—' }}<template v-if="s.docker"> · kernel {{ s.docker.kernel }} · {{ s.docker.arch }}</template></dd>
              <dt class="opacity-60">Folder</dt><dd class="font-mono text-xs leading-5 break-all"><a v-if="s.vm?.dir" class="link-hover cursor-pointer" @click="api.reveal(s.vm.dir)">{{ s.vm.dir }}</a></dd>
              <dt class="opacity-60">{{ words.os }}</dt><dd>{{ s.host.cpus }} CPUs · {{ s.host.memoryGiB }} GB · {{ s.host.arch }}</dd>
            </dl>
          </div>
        </div>

        <div v-if="!isSystem" class="card border-error/25">
          <div class="card-body flex-row items-center gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="font-semibold">Reset the {{ resetWhat ? `${resetWhat.name} engine` : 'engine' }}</h2>
              <p v-if="resetWhat" class="text-xs opacity-60">Deletes the {{ resetWhat.name }} VM and its disk: every container, image and volume in the {{ resetWhat.name }} engine, and its disk size goes back to the default. The {{ resetWhat.other }} engine and project folders on {{ words.thisComputer }} are not touched.</p>
              <p v-else-if="isWsl" class="text-xs opacity-60">Deletes DoCatz’s WSL distro and its disk: every container, image and volume in DoCatz — Standard and Lite share it. Your other WSL distros and project folders on {{ words.thisComputer }} are not touched.</p>
              <p v-else class="text-xs opacity-60">Deletes the VM and its disk: every container, image and volume in DoCatz. Project folders on {{ words.thisComputer }} are not touched.</p>
            </div>
            <button class="btn btn-sm btn-outline btn-error shrink-0" :disabled="s.status === 'missing' || !!busy" @click="resetting = true">Reset…</button>
          </div>
        </div>
      </div>
    </div>

    <dialog v-if="log !== null" open class="modal modal-open" @keydown.esc="log = null">
      <div class="modal-box w-[52rem] max-w-[95vw] space-y-3">
        <h3 class="text-lg font-semibold tracking-tight">Engine log</h3>
        <pre class="selectable max-h-[60vh] overflow-auto rounded-lg bg-base-200/70 p-3 font-mono text-[11px] whitespace-pre-wrap">{{ log }}</pre>
        <div class="modal-action"><button class="btn btn-ghost btn-sm" @click="copy(log)">Copy</button><button class="btn btn-sm" @click="log = null">Close</button></div>
      </div>
      <div class="modal-backdrop" @click="log = null" />
    </dialog>
    <dialog v-if="resetting" open class="modal modal-open z-[1000]" @keydown.esc="resetting = false">
      <form class="modal-box w-[30rem] max-w-[95vw] space-y-3" @submit.prevent="resetTyped.trim().toLowerCase() === 'reset' && reset()">
        <div class="flex items-start gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-error/12"><CatMood mood="warning" class="size-8" /></span>
          <div class="min-w-0"><h3 class="text-lg font-semibold tracking-tight">Reset the {{ resetWhat ? `${resetWhat.name} engine` : 'engine' }}?</h3><p class="text-sm opacity-70"><template v-if="resetWhat">Every container, image and volume in the {{ resetWhat.name }} engine goes; the {{ resetWhat.other }} engine keeps its own. The next start sets {{ resetWhat.name }} up fresh — its disk size can be set first in Settings.</template><template v-else-if="isWsl">Every container, image and volume in DoCatz goes, in Standard and Lite alike (one WSL distro). The next start sets the engine up fresh.</template><template v-else>Every container, image and volume in DoCatz goes. The next start sets the engine up fresh.</template></p></div>
        </div>
        <label class="block">
          <span class="label-caps mb-1 block">Type <CopyName value="reset" /> to go ahead</span>
          <input v-model="resetTyped" class="input input-sm w-full font-mono" placeholder="reset" spellcheck="false" autocomplete="off" autofocus />
        </label>
        <div class="modal-action"><button type="button" class="btn btn-ghost btn-sm" @click="resetting = false">Cancel</button><button class="btn btn-error btn-sm" :disabled="resetTyped.trim().toLowerCase() !== 'reset'">Reset</button></div>
      </form>
      <div class="modal-backdrop" @click="resetting = false" />
    </dialog>
    <PruneDialog v-if="pruning" :kind="pruning" @close="pruning = null" />
    <MigrateDialog v-if="moving" :source="moving" @close="moving = null" />
  </section>
</template>
