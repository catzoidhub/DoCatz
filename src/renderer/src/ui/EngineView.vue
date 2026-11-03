<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DcDiskUsage, DcMigrateSource, DcPruneKind, EngineConfig } from '@shared/types';
import { words } from '@shared/platform';
import { api, attempt, bytes, changes, engine, engineUp, notify } from '../store';
import CatMood from './CatMood.vue';
import DcNavButtons from './DcNavButtons.vue';
import PruneDialog from './PruneDialog.vue';
import TaskSteps from './TaskSteps.vue';
import WslSetup from './WslSetup.vue';
import MigrateDialog from './MigrateDialog.vue';

/**
 * Engine (DoCatz TODO #5 / #6 / #7): the VM's state and Start / Stop / Restart, its CPUs, memory, disk and Rosetta,
 * the docatz docker context, DoCatz's own CLIs and PATH, disk usage with clean-up, the engine log, and Reset.
 */
const s = computed(() => engine.value);
const c = computed(() => s.value?.config);
const isMac = computed(() => s.value?.backend === 'lima');
const busy = ref('');
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
const STATUS: Record<string, string> = { running: 'Running', stopped: 'Stopped', starting: 'Starting…', stopping: 'Stopping…', missing: 'Not set up', error: 'Needs attention', unsupported: 'Not available' };

async function set(patch: Partial<EngineConfig>) {
  const r = await attempt(() => api.engineConfigure(patch));
  if (r) engine.value = r;
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
                <p class="text-xs opacity-60">{{ s.docker ? `Docker ${s.docker.version} · ${s.docker.os} · ${s.docker.cpus} CPUs · ${bytes(s.docker.memory)}` : s.vm?.manager }}</p>
              </div>
              <template v-if="s.status === 'running'">
                <button class="btn btn-sm" :disabled="!!busy" @click="run('restart', () => api.engineRestart())"><span v-if="busy === 'restart'" class="loading loading-spinner loading-xs" />Restart</button>
                <button class="btn btn-sm" :disabled="!!busy" @click="run('stop', () => api.engineStop())"><span v-if="busy === 'stop'" class="loading loading-spinner loading-xs" />Stop</button>
              </template>
              <button v-else-if="!['unsupported', 'starting', 'stopping'].includes(s.status) && !s.task" class="btn btn-primary btn-sm" @click="run('start', () => api.engineStart())">{{ s.status === 'missing' ? 'Set up and start' : 'Start' }}</button>
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

        <!-- resources -->
        <div class="card">
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
                <input type="range" class="range range-primary range-xs" min="16" max="512" step="8" :value="c.diskGiB" @change="set({ diskGiB: Number(($event.target as HTMLInputElement).value) })" />
                <span class="text-right tabular-nums">{{ c.diskGiB }} GB</span>
              </label>
              <p class="text-xs opacity-60">The disk is the most it may grow to; it only takes what is used<template v-if="s.vm?.diskBytes"> (now {{ bytes(s.vm.diskBytes) }})</template>. It can grow later but not shrink.</p>
              <label v-if="s.host.rosetta" class="opt-row cursor-pointer">
                <span class="flex flex-col"><span class="label-caps">Rosetta for Intel images</span><span class="text-xs opacity-50">Runs linux/amd64 images fast on Apple silicon.</span></span>
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="c.rosetta" @change="set({ rosetta: ($event.target as HTMLInputElement).checked })" />
              </label>
            </template>
            <p v-else class="text-sm opacity-70">WSL 2 shares one set of limits between every distro: set them in <span class="font-mono">%USERPROFILE%\.wslconfig</span> (memory, processors), then restart the engine.</p>
            <label class="opt-row cursor-pointer">
              <span class="flex flex-col"><span class="label-caps">Start with DoCatz</span><span class="text-xs opacity-50">Starts the engine when DoCatz opens.</span></span>
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="c.autoStart" @change="set({ autoStart: ($event.target as HTMLInputElement).checked })" />
            </label>
          </div>
        </div>

        <!-- docker context and CLIs -->
        <div class="card">
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
                <span class="text-xs opacity-50">{{ isMac ? 'New terminals find DoCatz’s docker first (a line in .zprofile).' : 'New terminals find DoCatz’s docker (your user Path).' }}{{ s.cli.otherDocker ? ' Leave it off to keep using your own docker binary — the context is enough.' : '' }}</span>
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
        <div v-if="df" class="card">
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
        <div v-if="others.length" class="card">
          <div class="card-body gap-2">
            <h2>Move from another Docker</h2>
            <p class="text-xs opacity-60">Copy images and volumes onto DoCatz’s engine. The other one keeps them, so both can stay side by side.</p>
            <ul class="divide-y divide-base-300/50">
              <li v-for="o in others" :key="o.id" class="flex items-center gap-3 py-2">
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-medium">{{ o.name }}</span>
                  <span class="block text-xs opacity-55">{{ o.running ? `Running · Docker ${o.version}` : 'Installed, not running — start it to move from it' }}</span>
                </span>
                <button v-if="o.running" class="btn btn-sm" @click="moving = o">Choose what to move…</button>
                <button v-else class="btn btn-ghost btn-sm" @click="lookAgain">Look again</button>
              </li>
            </ul>
          </div>
        </div>

        <!-- details -->
        <div class="card">
          <div class="card-body gap-2">
            <div class="flex items-center gap-2"><h2>Details</h2><span class="flex-1" /><button class="btn btn-ghost btn-xs" @click="showLog">Engine log</button></div>
            <dl class="selectable grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt class="opacity-60">VM</dt><dd>{{ s.vm?.manager ?? '—' }}<template v-if="s.docker"> · kernel {{ s.docker.kernel }} · {{ s.docker.arch }}</template></dd>
              <dt class="opacity-60">Folder</dt><dd class="font-mono text-xs leading-5 break-all"><a v-if="s.vm?.dir" class="link-hover cursor-pointer" @click="api.reveal(s.vm.dir)">{{ s.vm.dir }}</a></dd>
              <dt class="opacity-60">{{ words.os }}</dt><dd>{{ s.host.cpus }} CPUs · {{ s.host.memoryGiB }} GB · {{ s.host.arch }}</dd>
            </dl>
          </div>
        </div>

        <div class="card border-error/25">
          <div class="card-body flex-row items-center gap-3">
            <div class="min-w-0 flex-1">
              <h2 class="font-semibold">Reset the engine</h2>
              <p class="text-xs opacity-60">Deletes the VM and its disk: every container, image and volume in DoCatz. Project folders on {{ words.thisComputer }} are not touched.</p>
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
          <div class="min-w-0"><h3 class="text-lg font-semibold tracking-tight">Reset the engine?</h3><p class="text-sm opacity-70">Every container, image and volume in DoCatz goes. The next start sets the engine up fresh.</p></div>
        </div>
        <label class="block">
          <span class="label-caps mb-1 block">Type <span class="font-mono normal-case tracking-normal opacity-100">reset</span> to go ahead</span>
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
