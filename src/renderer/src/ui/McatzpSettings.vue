<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { words } from '@shared/platform';
import type { DcComposeProject, McatzpActivity, McatzpApproval, McatzpSettings, McatzpSetup, McatzpTarget } from '@shared/types';
import dbcatzLogo from '../assets/logos/dbcatz.png';
import devcatzLogo from '../assets/logos/devcatz.png';
import dialcatzLogo from '../assets/logos/dialcatz.png';
import docatzLogo from '../assets/logos/docatz.png';
import mcatzpLogo from '../assets/logos/mcatzp.svg';
import { CLIENT_ICONS } from './clientmarks';
import { api, attempt, changes, engineUp, mcatzpInstalling, notify, settings } from '../store';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import CatMood from './CatMood.vue';
import StackMark from './StackMark.vue';

/** Settings → MCatzP: the switch, what is shared, the approved clients and what they did. */
const thisComputer = words.thisComputer;
const s = computed<McatzpSettings>(() => settings.value!.mcatzp);
const on = computed(() => s.value.on);
const list = ref<DcComposeProject[]>([]);
const loadProjects = async () => {
  if (engineUp.value) list.value = ((await api.projects().catch(() => list.value)) as DcComposeProject[]).slice().sort((a, b) => a.name.localeCompare(b.name));
};
watch([engineUp, changes], () => void loadProjects(), { immediate: true });
const shared = computed(() => new Set(s.value.projects));
async function save(patch: Partial<Omit<McatzpSettings, 'clients'>>) {
  const next = await attempt(() => api.setSettings({ mcatzp: patch }));
  if (next) settings.value = next;
}
const saveNames = (key: 'envPublic' | 'envSecret', text: string) => save({ [key]: text.split(/[\s,]+/).filter((n) => /^[A-Za-z_][\w.]*$/.test(n)) });
function toggleProject(id: string, yes: boolean) {
  const next = new Set(shared.value);
  if (yes) next.add(id);
  else next.delete(id);
  void save({ projects: [...next] });
}

// The program clients start: one copy per computer.
const setup = ref<McatzpSetup | null>(null);
const installing = mcatzpInstalling;
const percent = computed(() => (installing.value?.total ? Math.round((installing.value.received / installing.value.total) * 100) : 0));
const outdated = computed(() => {
  const [a, b] = [setup.value?.version, setup.value?.latest];
  if (!a || !b || setup.value?.source !== 'catzoid') return false;
  return a.localeCompare(b, undefined, { numeric: true }) < 0;
});
const updateHow = { homebrew: 'Homebrew', other: 'how you installed it' } as const;
async function installMcatzp() {
  const next = await attempt(() => api.mcatzpInstall());
  if (next) setup.value = next;
  void loadTargets();
}
/** Uninstall (user, 2026-11-10; every Catzoid app has it, as DevCatz c0a4291): out of every assistant, and the shared copy when a Catzoid app installed it. */
const uninstalling = ref<{ text: string } | null>(null);
const uninstallBusy = ref(false);
function askUninstall() {
  const where = targets.value.filter((t) => t.current).map((t) => t.label);
  const s = setup.value;
  uninstalling.value = {
    text: `${where.length ? `It is taken out of ${where.join(', ')}. ` : ''}${
      s?.source === 'catzoid' ? `The program (${s.path}) is removed. ` : s?.path ? `Your own copy (${s.path}) stays: remove it the way you installed it. ` : ''
    }Every Catzoid app shares MCatzP, so they lose it too; this app's MCatzP switch turns off. Install it again any time.`,
  };
}
async function uninstallMcatzp() {
  uninstallBusy.value = true;
  const r = await attempt(() => api.mcatzpUninstall());
  uninstallBusy.value = false;
  uninstalling.value = null;
  if (!r) return;
  notify('success', r.binary === 'kept' ? `MCatzP taken out of the assistants; your copy at ${r.keptPath} stays` : 'MCatzP uninstalled');
  settings.value = (await attempt(() => api.settings())) ?? settings.value;
  setup.value = (await attempt(() => api.mcatzpSetup(false))) ?? setup.value;
  void loadTargets();
}
const targets = ref<McatzpTarget[]>([]);
// What is on this computer first; the rest only when asked for.
const showAllTargets = ref(false);
const foundTargets = computed(() => targets.value.filter((t) => t.found || t.command !== null));
const shownTargets = computed(() => (showAllTargets.value ? [...foundTargets.value, ...targets.value.filter((t) => !t.found && t.command === null)] : foundTargets.value));
const hiddenTargets = computed(() => targets.value.length - foundTargets.value.length);
const clientBusy = ref<string | null>(null);
const clientChanged = ref<string | null>(null);
const loadTargets = async () => {
  targets.value = (await attempt(() => api.mcatzpTargets())) ?? targets.value;
};
const replacing = ref<McatzpTarget | null>(null);
async function addClient(t: McatzpTarget, sure = false) {
  if (t.command !== null && !sure) return void (replacing.value = t);
  replacing.value = null;
  clientBusy.value = t.id;
  const next = await attempt(() => api.mcatzpAddToClient(t.id));
  clientBusy.value = null;
  if (next) {
    targets.value = next;
    clientChanged.value = t.label;
  }
}
async function removeClient(t: McatzpTarget) {
  clientBusy.value = t.id;
  const next = await attempt(() => api.mcatzpRemoveFromClient(t.id));
  clientBusy.value = null;
  if (next) targets.value = next;
}
const cancelInstall = () => attempt(() => api.mcatzpInstallCancel().then(() => true));

const SECTIONS = [
  { id: 'clients', label: 'Clients' },
  { id: 'access', label: 'Access' },
  { id: 'activity', label: 'Activity' },
] as const;
const section = ref<(typeof SECTIONS)[number]['id']>('clients');

const APP_LOGO: Record<McatzpApproval['id'], string> = { devcatz: devcatzLogo, dbcatz: dbcatzLogo, dialcatz: dialcatzLogo, docatz: docatzLogo };
const approvals = ref<McatzpApproval[]>([]);
const activity = ref<McatzpActivity[]>([]);
const load = async () => {
  if (on.value && section.value !== 'access') activity.value = (await attempt(() => api.mcatzpActivity())) ?? activity.value;
  if (on.value && section.value === 'clients') approvals.value = (await attempt(() => api.mcatzpApprovals())) ?? approvals.value;
};
// While this page is open only: calls come from outside DoCatz, with no state change to follow.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  // What is on this computer first: the site may take a while.
  void attempt(() => api.mcatzpSetup(false)).then((r) => r && !setup.value && (setup.value = r));
  void attempt(() => api.mcatzpSetup()).then((r) => r && (setup.value = r));
  void loadTargets();
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(section, () => void load());
const revoke = (name: string) => attempt(() => api.mcatzpRevoke(name).then(() => true));
async function clearLog() {
  await attempt(() => api.mcatzpClearActivity().then(() => true));
  activity.value = [];
}
const TONE = { ok: 'text-success', refused: 'text-error', declined: 'text-warning', failed: 'text-error' } as const;
const DOT = { ok: 'status-success', refused: 'status-error', declined: 'status-warning', failed: 'status-error' } as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const MARK: Partial<Record<McatzpTarget['id'], string>> = { 'claude-code': 'claude', 'claude-desktop': 'claude', zcode: 'zcode', zed: 'zed', cursor: 'cursor', windsurf: 'windsurf', vscode: 'visualstudiocode', cline: 'cline', gemini: 'googlegemini', codex: 'openai', opencode: 'opencode', copilot: 'githubcopilot', kiro: 'kiro', qwen: 'qwen', lmstudio: 'lmstudio', roo: 'roo', amp: 'amp', warp: 'warp', antigravity: 'antigravity' };
/** Which listed assistant a client is, by the name it gives itself; null for any other, which keeps its initial. */
function clientTarget(name: string): McatzpTarget['id'] | null {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (n.startsWith('claudecode')) return 'claude-code';
  if (n.startsWith('claude')) return 'claude-desktop';
  if (n.startsWith('visualstudiocode') || n.startsWith('vscode')) return 'vscode';
  if (n.startsWith('gemini')) return 'gemini';
  if (n.startsWith('github') || n.startsWith('copilot')) return 'copilot';
  return (['zcode', 'zed', 'cursor', 'windsurf', 'cline', 'codex', 'opencode', 'kiro', 'antigravity', 'qwen', 'lmstudio', 'roo', 'amp', 'warp'] as const).find((id) => n.startsWith(id)) ?? null;
}

/** Each approved client with what the log knows about it, the most recent first. */
const clients = computed(() => {
  // Those approved here, then those only approved in another Catzoid app.
  const here = s.value.clients;
  const names = [...new Set([...here.map((c) => c.name), ...approvals.value.flatMap((a) => a.clients)])];
  const list = names.map((name) => {
    const own = activity.value.filter((a) => a.client === name && a.action);
    const id = clientTarget(name);
    const mine = here.find((c) => c.name === name);
    const others = approvals.value.filter((a) => a.id !== 'docatz' && a.clients.includes(name));
    return {
      name,
      approvedAt: mine?.approvedAt ?? null,
      last: own[0]?.time ?? null,
      calls: own.length,
      mark: id ? (MARK[id] ?? null) : null,
      account: targets.value.find((t) => t.id === id)?.account,
      apps: [...(mine ? [{ id: 'docatz' as const, name: 'DoCatz' }] : []), ...others],
    };
  });
  return list.sort((a, b) => Number(!a.approvedAt) - Number(!b.approvedAt) || (b.last ?? b.approvedAt ?? '').localeCompare(a.last ?? a.approvedAt ?? ''));
});

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'changes', label: 'Changes' },
  { id: 'problems', label: 'Problems' },
] as const;
const filter = ref<(typeof FILTERS)[number]['id']>('all');

/** By day, with a run of the same call folded into one row (a client polling a status is one line, not fifty). */
const groups = computed(() => {
  const out: { day: string; rows: (McatzpActivity & { key: string; name: string; count: number })[] }[] = [];
  activity.value.forEach((a, i) => {
    if (filter.value === 'changes' && a.tier !== 'change' && a.tier !== 'destructive') return;
    if (filter.value === 'problems' && a.outcome === 'ok') return;
    const d = day(a.time);
    const name = a.action ?? a.method;
    if (out.at(-1)?.day !== d) out.push({ day: d, rows: [] });
    const rows = out.at(-1)!.rows;
    const prev = rows.at(-1);
    if (prev && prev.name === name && prev.client === a.client && prev.outcome === a.outcome) prev.count++;
    else rows.push({ ...a, key: `${a.time}-${i}`, name, count: 1 });
  });
  return out;
});
</script>

<template>
  <div class="card">
    <div class="card-body gap-3 p-4">
      <div class="flex items-center gap-3">
        <img :src="mcatzpLogo" alt="" class="logo size-14 shrink-0 rounded-2xl" draggable="false" />
        <div class="min-w-0">
          <h2 class="text-lg font-semibold tracking-tight">MCatzP</h2>
          <p class="text-xs opacity-60">One connection, every cat.</p>
        </div>
      </div>
      <label class="mt-2 flex cursor-pointer items-start gap-3">
        <input type="checkbox" class="toggle toggle-primary toggle-sm mt-0.5" :checked="on" @change="save({ on: ($event.target as HTMLInputElement).checked })" />
        <span>
          Let AI assistants use DoCatz through MCatzP
          <span class="block text-xs opacity-60">An MCP client you approve can read the compose projects you share, with secret values masked, and ask to make changes, which DoCatz confirms with you first. It reaches DoCatz through a channel only your account on {{ thisComputer }} can open. What it reads goes to that assistant's model provider.</span>
        </span>
      </label>
      <!-- Clients start this program, so it is what a client's setup points at. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-base-300/50 pt-3 text-sm">
        <div class="min-w-0 flex-1 basis-64">
          <template v-if="installing">
            <span>{{ installing.phase === 'install' ? 'Installing MCatzP…' : 'Downloading MCatzP…' }}</span>
            <progress v-if="installing.phase === 'install' || installing.total" class="progress progress-primary mt-1 block w-full" :value="installing.phase === 'install' ? 100 : percent" max="100" />
            <progress v-else class="progress progress-primary mt-1 block w-full" />
          </template>
          <template v-else-if="setup?.path">
            <span class="flex flex-wrap items-center gap-2">MCatzP {{ setup.version }} is on {{ thisComputer }}<span class="badge badge-ghost badge-sm font-normal" title="Install or add it from any Catzoid app and the others use the same">Shared with Catzoid apps</span></span>
            <code class="selectable mt-0.5 block truncate text-xs opacity-60" :title="setup.path">{{ setup.path }}</code>
            <span v-if="setup.source && setup.source !== 'catzoid'" class="block text-xs opacity-60">DoCatz uses this copy. Update it with {{ updateHow[setup.source] }}.</span>
          </template>
          <template v-else-if="setup">
            <span class="flex flex-wrap items-center gap-2">MCatzP is not on {{ thisComputer }} yet<span class="badge badge-ghost badge-sm font-normal" title="Install or add it from any Catzoid app and the others use the same">Shared with Catzoid apps</span></span>
            <span class="block text-xs opacity-60">
              <template v-if="setup.error">The site could not be reached: {{ setup.error }}</template>
              <template v-else-if="setup.noBuild">There is no build for {{ thisComputer }} yet.</template>
              <template v-else>AI assistants start this small program to reach DoCatz. It goes in one place, for every Catzoid app.</template>
            </span>
          </template>
        </div>
        <button v-if="installing" class="btn btn-sm" :disabled="installing.phase === 'install'" @click="cancelInstall">Cancel</button>
        <button v-else-if="setup && !setup.path" class="btn btn-primary btn-sm" :disabled="!setup.checked || setup.noBuild" @click="installMcatzp">Install MCatzP</button>
        <button v-else-if="outdated" class="btn btn-sm mcatzp-update" @click="installMcatzp">Update to {{ setup?.latest }}</button>
        <button v-if="!installing && setup?.path" class="btn btn-ghost btn-sm text-error" title="Take MCatzP out of every assistant and remove the program a Catzoid app installed" @click="askUninstall">Uninstall…</button>
      </div>

      <template v-if="on">
        <div role="tablist" class="seg self-start">
          <button v-for="t in SECTIONS" :key="t.id" role="tab" class="seg-item" :class="{ 'is-active': section === t.id }" @click="section = t.id">{{ t.label }}</button>
        </div>

        <div v-if="section === 'clients'" class="flex flex-col gap-4">
          <div v-if="targets.length">
            <span class="mb-2 flex flex-wrap items-center gap-2"><span class="label-caps">AI assistants</span><span class="badge badge-ghost badge-sm font-normal" title="Install or add it from any Catzoid app and the others use the same">Shared with Catzoid apps</span></span>
            <ul class="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              <li v-for="t in shownTargets" :key="t.id" class="flex min-w-0 items-center gap-2.5 rounded-box border border-base-300/60 p-2.5 text-sm" :class="{ 'opacity-60': !t.found && t.command === null }">
                <StackMark v-if="MARK[t.id]" :icon="CLIENT_ICONS[MARK[t.id]!]" :label="t.label" class="size-7 shrink-0" />
                <span v-else class="avatar-letter avatar-small" aria-hidden="true">{{ t.label.slice(0, 1) }}</span>
                <div class="min-w-0 flex-1">
                  <p class="flex items-center gap-1.5 font-medium"><span class="truncate">{{ t.label }}</span><span v-if="t.command !== null" class="status status-xs shrink-0" :class="t.current ? 'status-success' : 'status-warning'" /></p>
                  <p class="truncate text-xs opacity-60" :title="t.command ?? t.account ?? ''">
                    <template v-if="t.command !== null && !t.current">Runs another copy</template>
                    <template v-else-if="t.account">{{ t.current ? 'Added · ' : '' }}{{ t.account }}</template>
                    <template v-else>{{ !t.found ? `Not on ${thisComputer}` : t.current ? 'Added' : 'Not added' }}</template>
                  </p>
                </div>
                <button v-if="t.command !== null" class="btn btn-ghost btn-xs shrink-0" :disabled="clientBusy === t.id" @click="removeClient(t)">Remove</button>
                <button v-if="t.found && !t.current" class="btn btn-xs shrink-0" :disabled="!setup?.path || clientBusy === t.id" :title="setup?.path ? `Add MCatzP to ${t.label}` : 'Install MCatzP first'" @click="addClient(t)">
                  <span v-if="clientBusy === t.id" class="loading loading-spinner loading-xs" />{{ t.command !== null ? 'Use this copy' : 'Add' }}
                </button>
              </li>
            </ul>
          <button v-if="hiddenTargets" class="btn btn-ghost btn-xs mt-1" @click="showAllTargets = !showAllTargets">{{ showAllTargets ? `Show only what is on ${thisComputer}` : `Show ${hiddenTargets} not on ${thisComputer}` }}</button>
            <p v-if="clientChanged" class="mt-2 text-xs opacity-70">Start a new session in {{ clientChanged }} so it picks up the change.</p>
          </div>

          <div>
            <span class="label-caps mb-2 block">Approved</span>
            <p v-if="!clients.length" class="text-xs opacity-60">None yet. A client asks in DoCatz the first time it connects, and shows up here once you allow it.</p>
            <ul v-if="clients.length" class="divide-y divide-base-300/50 overflow-hidden rounded-box border border-base-300/60">
              <li v-for="c in clients" :key="c.name" class="flex items-center gap-3 px-3 py-2.5">
                <StackMark v-if="c.mark" :icon="CLIENT_ICONS[c.mark]" :label="c.name" class="size-9 shrink-0" />
                <span v-else class="avatar-letter" aria-hidden="true">{{ c.name.slice(0, 1).toUpperCase() }}</span>
                <div class="min-w-0 flex-1">
                  <p class="selectable truncate text-sm font-medium">{{ c.name }}</p>
                  <p class="truncate text-xs opacity-60">
                    <template v-if="c.account">{{ c.account }} · </template><template v-if="c.approvedAt">Approved here {{ day(c.approvedAt) }}</template><template v-else>Not approved here: it asks the first time it connects</template><template v-if="c.last"> · last call {{ when(c.last) }} · {{ c.calls }} {{ c.calls === 1 ? 'call' : 'calls' }}</template>
                  </p>
                  <p class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span class="opacity-60">Approved in</span>
                    <span v-for="a in c.apps" :key="a.id" class="app-chip"><img :src="APP_LOGO[a.id]" alt="" class="size-3.5 rounded-sm" draggable="false" />{{ a.name }}</span>
                  </p>
                </div>
                <button v-if="c.approvedAt" class="btn btn-sm" @click="revoke(c.name)">Revoke</button>
              </li>
            </ul>
          </div>
        </div>

        <div v-else-if="section === 'access'" class="flex flex-col gap-3">
        <div>
          <span class="label-caps mb-2 block">Shared projects</span>
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm" :checked="s.all" @change="save({ all: ($event.target as HTMLInputElement).checked })" />
            All compose projects and loose containers, including new ones
          </label>
          <div v-if="!s.all" class="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-box border border-base-300/60 p-2">
            <p v-if="!list.length" class="px-1 text-xs opacity-60">{{ engineUp ? 'No compose projects yet.' : 'Start the engine to see the projects.' }}</p>
            <label v-for="p in list" :key="p.name" class="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" class="checkbox checkbox-xs" :checked="shared.has(p.name)" @change="toggleProject(p.name, ($event.target as HTMLInputElement).checked)" />
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
              <span class="shrink-0 text-xs opacity-50">{{ p.running }}/{{ p.containers }} running</span>
            </label>
          </div>
          <p v-if="!s.all && !shared.size" class="mt-1 text-xs opacity-60">Nothing shared yet: clients see no projects until you tick some.</p>
        </div>

        <div class="space-y-2 border-t border-base-300/50 pt-3">
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.logs" @change="save({ logs: ($event.target as HTMLInputElement).checked })" />
            <span>Logs<span class="block text-xs opacity-60">Container, build and engine logs. Secret values are masked wherever they appear, but a log can hold personal data, which then goes to the assistant's model provider. Off: clients see no logs.</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.resources" @change="save({ resources: ($event.target as HTMLInputElement).checked })" />
            <span>Images, volumes, networks and builds<span class="block text-xs opacity-60">They belong to the engine, not to one project: names, sizes and what uses them, whichever projects you share. Never what is inside a volume.</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.changes" @change="save({ changes: ($event.target as HTMLInputElement).checked })" />
            <span>Let clients ask for changes<span class="block text-xs opacity-60">Up, stop, build and pull, start and stop a container, the engine, a project's environment, its compose file. DoCatz shows you each one first; for what cannot be undone you type a name. There is no terminal: a client never runs a command of its own. Off: clients can only read.</span></span>
          </label>
        </div>

        <div class="space-y-2 border-t border-base-300/50 pt-3">
          <span class="label-caps block">Environment variables</span>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.envValues" @change="save({ envValues: ($event.target as HTMLInputElement).checked })" />
            <span>Values that are not secret<span class="block text-xs opacity-60">Names are always readable in shared projects. A secret's value only goes out one at a time, after you allow it. DoCatz tells them apart by the name; correct it below.</span></span>
          </label>
          <label class="flex items-center gap-2 text-xs">
            <span class="w-20 shrink-0 opacity-70">Not secret</span>
            <input class="input input-sm min-w-0 flex-1 font-mono text-xs" :value="s.envPublic.join(', ')" placeholder="SESSION_DRIVER, TOKEN_TTL" spellcheck="false" @change="saveNames('envPublic', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="flex items-center gap-2 text-xs">
            <span class="w-20 shrink-0 opacity-70">Secret</span>
            <input class="input input-sm min-w-0 flex-1 font-mono text-xs" :value="s.envSecret.join(', ')" placeholder="INTERNAL_URL, LICENSE" spellcheck="false" @change="saveNames('envSecret', ($event.target as HTMLInputElement).value)" />
          </label>
        </div>
        </div>

        <div v-else>
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <div role="tablist" class="seg seg-xs">
              <button v-for="f in FILTERS" :key="f.id" role="tab" class="seg-item" :class="{ 'is-active': filter === f.id }" @click="filter = f.id">{{ f.label }}</button>
            </div>
            <span class="flex-1" />
            <button v-if="activity.length" class="btn btn-ghost btn-xs" @click="clearLog">Clear</button>
          </div>
          <div v-if="!groups.length" class="empty">
            <CatMood mood="info" class="size-14" />
            <p class="font-medium">{{ activity.length ? 'Nothing here' : 'No activity yet' }}</p>
            <p class="text-xs opacity-60">{{ activity.length ? 'No call matches this filter.' : 'Every call is listed here: names and outcomes, never what was read.' }}</p>
          </div>
          <div v-else class="log max-h-[30rem] overflow-y-auto rounded-box border border-base-300/60">
            <section v-for="g in groups" :key="g.day">
              <h3 class="log-day">{{ g.day }}</h3>
              <div v-for="r in g.rows" :key="r.key" class="log-row" :title="r.reason">
                <span class="status status-sm shrink-0" :class="DOT[r.outcome]" />
                <code class="selectable min-w-0 flex-1 truncate text-xs">{{ r.name }}<span v-if="r.count > 1" class="ml-1.5 opacity-50">×{{ r.count }}</span></code>
                <span class="flex w-20 shrink-0 justify-end">
                  <span v-if="r.tier === 'destructive'" class="badge badge-xs badge-error badge-outline">destructive</span>
                  <span v-else-if="r.tier === 'change'" class="badge badge-xs badge-ghost">change</span>
                </span>
                <span class="hidden w-24 shrink-0 truncate text-xs opacity-60 sm:block">{{ r.client }}</span>
                <span class="w-16 shrink-0 text-right text-xs font-medium" :class="TONE[r.outcome]">{{ r.outcome === 'ok' ? '' : r.outcome }}</span>
                <span class="w-14 shrink-0 text-right text-xs tabular-nums opacity-50">{{ clock(r.time) }}</span>
              </div>
            </section>
          </div>
        </div>
      </template>
    </div>
    <ConfirmDialog v-if="uninstalling" title="Uninstall MCatzP?" :text="uninstalling.text" confirm="Uninstall" tone="error" :busy="uninstallBusy" @ok="uninstallMcatzp" @cancel="uninstalling = null" />
    <ConfirmDialog v-if="replacing" :title="`Point ${replacing.label} at this copy?`" :text="`It already runs MCatzP as: ${replacing.command}`" confirm="Use this copy" tone="primary" @ok="addClient(replacing!, true)" @cancel="replacing = null" />
  </div>
</template>

<style scoped>
/* MCatzP's own pink, so the page is known at a glance. */
.logo {
  box-shadow: 0 0 0 1px color-mix(in oklab, #ff8dbe 45%, transparent), 0 6px 20px color-mix(in oklab, #ff8dbe 35%, transparent);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 2rem 1rem;
  text-align: center;
}
.avatar-letter {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 0.625rem;
  background: color-mix(in oklab, #ff8dbe 18%, transparent);
  color: #ff8dbe;
  font-weight: 600;
}
.avatar-small {
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
}
.app-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border-radius: 0.375rem;
  background: color-mix(in oklab, var(--color-base-content) 8%, transparent);
  padding: 0.0625rem 0.375rem;
}
.log-day {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0.375rem 0.75rem;
  background: var(--color-base-200);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  opacity: 0.85;
  text-transform: uppercase;
}
.log-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.75rem;
}
.log-row + .log-row {
  border-top: 1px solid color-mix(in oklab, var(--color-base-300) 45%, transparent);
}
</style>
