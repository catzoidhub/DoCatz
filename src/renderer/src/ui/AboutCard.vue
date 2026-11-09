<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AboutInfo, SiblingApp } from '@shared/types';
import { words } from '@shared/platform';
import { api, attempt, notify, REPO, reportOpen, SLOGAN, update, updateOpen } from '../store';
import DcUninstallDialog from './DcUninstallDialog.vue';
import devcatzLogo from '../assets/logos/devcatz.png';
import dbcatzLogo from '../assets/logos/dbcatz.png';
import dialcatzLogo from '../assets/logos/dialcatz.png';
import docatzLogo from '../assets/logos/docatz.png';
import mcatzpLogo from '../assets/logos/mcatzp.svg';

/**
 * Settings → About (Catzoid family #62; the app menu's About DoCatz opens it), laid out like DialCatz's AboutCard:
 * the app, its slogan and version, the Catzoid family, and links built from the shared site address
 * (Catzoid/shared.json `site`), so they follow dev.catzoid.tech → catzoid.com without a rebuild. Check for Updates
 * (#54), Report a bug / Send feedback (#65) and Uninstall (#55) sit here too.
 */
const LICENCE = { name: 'GPL-3.0', url: 'https://www.gnu.org/licenses/gpl-3.0.html' };

const info = ref<AboutInfo | null>(null);
onMounted(async () => (info.value = (await attempt(() => api.aboutInfo())) ?? null));
/** The siblings' installed versions and the newest the site has for this computer (#60): "1.0.3 · 1.0.4 available". */
const versions = ref<Record<SiblingApp, { installed: string | null; latest: string | null }> | null>(null);
onMounted(async () => (versions.value = await api.siblingVersions().catch(() => null)));
const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};
function versionLine(name: string): { text: string; fresh: boolean } | null {
  const v = versions.value?.[name.toLowerCase() as SiblingApp];
  if (!v) return null;
  if (!v.installed) return { text: v.latest ? `not installed · ${v.latest}` : 'not installed', fresh: false };
  if (v.latest && newer(v.latest, v.installed)) return { text: `${v.installed} · ${v.latest} available`, fresh: true };
  return { text: v.installed, fresh: false };
}

/** The build, with its OS: "macOS Apple silicon", "macOS Intel", "Windows x64", "Linux ARM64" — never the architecture alone. */
const arch = computed(() => {
  const a = info.value?.arch;
  if (!a) return '';
  const name = words.os === 'macOS' ? ({ arm64: 'Apple silicon', x64: 'Intel' } as Record<string, string>)[a] : ({ arm64: 'ARM64', x64: 'x64' } as Record<string, string>)[a];
  return `${words.os} ${name ?? a}`;
});
const host = computed(() => (info.value ? new URL(info.value.site).host : ''));
const links = computed(() => {
  const site = info.value?.site;
  if (!site) return [];
  const v = info.value!.version;
  return [
    { label: 'DoCatz website', url: `${site}/docatz` },
    { label: 'Docs', url: `${site}/docs` },
    { label: "What's new", url: `${REPO}/releases/tag/v${v}` },
    { label: 'Report an issue', url: `${REPO}/issues/new` },
    { label: 'GitHub', url: REPO },
    { label: 'Third-party licences', url: 'app:licenses' },
  ];
});
/** Each card opens that app's page on the site (<site>/devcatz …). */
const FAMILY: { name: string; logo: string; what: string }[] = [
  { name: 'DevCatz', logo: devcatzLogo, what: 'local dev environment' },
  { name: 'DBCatz', logo: dbcatzLogo, what: 'database viewer' },
  { name: 'DialCatz', logo: dialcatzLogo, what: 'API client' },
  { name: 'DoCatz', logo: docatzLogo, what: 'container manager' },
];
/** Not one of the apps but the link between them, so it sits apart, under the four (<site>/mcatzp). */
const MCATZP = { name: 'MCatzP', logo: mcatzpLogo, what: 'One MCP server for the whole family: your AI assistant works with every Catzoid app you have, only as far as you allow.' };

const waiting = computed(() => ['available', 'downloading', 'downloaded'].includes(update.value?.status ?? ''));
function checkUpdates() {
  updateOpen.value = true;
  if (!waiting.value) void api.updateCheck();
}
function copyDetails() {
  const i = info.value;
  if (!i) return;
  void navigator.clipboard.writeText(`DoCatz ${i.version} (${arch.value || i.arch})\n${words.os} ${i.macos}\nElectron ${i.electron} · Chromium ${i.chrome} · Node.js ${i.node}`);
  notify('success', 'Version details copied');
}
const uninstalling = ref(false);
</script>

<template>
  <div class="card">
    <div class="card-body items-center gap-5 py-8 text-center">
      <img :src="docatzLogo" alt="" class="size-24 drop-shadow-md" draggable="false" />
      <div class="space-y-1.5">
        <h2 class="text-2xl font-semibold tracking-tight">DoCatz</h2>
        <p class="text-sm italic opacity-70">{{ SLOGAN }}</p>
        <p class="selectable text-sm opacity-60">
          Version {{ info?.version ?? '…' }}<template v-if="arch"> · {{ arch }}</template>
        </p>
      </div>
      <div class="flex flex-wrap justify-center gap-1.5">
        <button v-for="l in links" :key="l.label" class="btn btn-ghost btn-sm" @click="api.openUrl(l.url)">{{ l.label }}</button>
      </div>
      <div class="flex flex-wrap justify-center gap-2">
        <button class="btn btn-sm" @click="checkUpdates">
          <span v-if="update?.status === 'checking'" class="loading loading-spinner loading-xs" /><span v-else-if="update?.status === 'available' || update?.status === 'downloaded'" class="size-2 rounded-full bg-primary" />{{ waiting ? 'Update available…' : 'Check for Updates' }}
        </button>
        <button class="btn btn-sm" @click="reportOpen = 'bug'">Report a bug</button>
        <button class="btn btn-sm" @click="reportOpen = 'idea'">Send feedback</button>
      </div>
      <p class="text-xs opacity-55">
        Free and open source under the
        <a class="link" @click="api.openUrl(LICENCE.url)">{{ LICENCE.name }}</a> licence.
      </p>
      <p class="text-xs opacity-55">
        ★ If DoCatz helps you, <a class="link" @click="api.openUrl(REPO)">star it on GitHub</a> and tell a friend — that is how other developers find it.
      </p>
    </div>
  </div>

  <div class="card">
    <div class="card-body gap-3">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Part of the Catzoid family</h2>
        <span class="flex-1" />
        <button v-if="info" class="btn btn-ghost btn-xs" @click="api.openUrl(info.site)">{{ host }}</button>
      </div>
      <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <li v-for="f in FAMILY" :key="f.name">
          <button
            type="button"
            class="flex h-full w-full items-center gap-2.5 rounded-box border border-base-300/60 bg-base-200/40 px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-base-200 disabled:cursor-default"
            :title="info ? `${info.site}/${f.name.toLowerCase()}` : undefined"
            :disabled="!info"
            @click="api.openUrl(`${info!.site}/${f.name.toLowerCase()}`)"
          >
            <img :src="f.logo" alt="" class="size-8 shrink-0" draggable="false" />
            <span class="min-w-0">
              <span class="block text-sm font-medium leading-tight">{{ f.name }}</span>
              <span class="block text-[11px] leading-tight opacity-55">{{ f.what }}</span>
              <span v-if="versionLine(f.name)" class="block text-[11px] leading-tight" :class="versionLine(f.name)!.fresh ? 'font-medium text-[var(--primary-ink)]' : 'opacity-45'">{{ versionLine(f.name)!.text }}</span>
            </span>
          </button>
        </li>
      </ul>
      <div class="flex items-center gap-3 pt-1">
        <span class="label-caps shrink-0 opacity-60">Connects them all</span>
        <span class="h-px flex-1 bg-base-300/60" />
      </div>
      <button
        type="button"
        class="flex w-full items-center gap-3 rounded-box border border-base-300/60 bg-base-200/40 px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-base-200 disabled:cursor-default"
        :title="info ? `${info.site}/mcatzp` : undefined"
        :disabled="!info"
        @click="api.openUrl(`${info!.site}/mcatzp`)"
      >
        <img :src="MCATZP.logo" alt="" class="size-10 shrink-0" draggable="false" />
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium leading-tight">{{ MCATZP.name }}</span>
          <span class="block text-[11px] leading-snug opacity-55">{{ MCATZP.what }}</span>
        </span>
      </button>
      <p class="text-xs opacity-55">Links follow the Catzoid site address shared by the Catzoid apps ({{ host || '…' }}).</p>
    </div>
  </div>

  <div class="card">
    <div class="card-body gap-3">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Details</h2>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs" :disabled="!info" @click="copyDetails">Copy</button>
      </div>
      <dl v-if="info" class="selectable grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt class="opacity-60">{{ words.os }}</dt><dd class="font-mono text-xs leading-5">{{ info.macos }}</dd>
        <dt class="opacity-60">Electron</dt><dd class="font-mono text-xs leading-5">{{ info.electron }}</dd>
        <dt class="opacity-60">Chromium</dt><dd class="font-mono text-xs leading-5">{{ info.chrome }}</dd>
        <dt class="opacity-60">Node.js</dt><dd class="font-mono text-xs leading-5">{{ info.node }}</dd>
        <dt class="opacity-60">Data folder</dt><dd class="font-mono text-xs leading-5 break-all">{{ info.dataDir }}</dd>
      </dl>
    </div>
  </div>

  <div class="card border-error/25">
    <div class="card-body flex-row items-center gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="font-semibold">Uninstall DoCatz</h2>
        <p class="text-xs opacity-60">Removes DoCatz, its engine (every container, image and volume in it), the docatz docker context and its settings from {{ words.thisComputer }}. Project folders your containers used stay.</p>
      </div>
      <button class="btn btn-sm btn-outline btn-error shrink-0" @click="uninstalling = true">Uninstall…</button>
    </div>
  </div>
  <DcUninstallDialog v-if="uninstalling" @close="uninstalling = false" />
</template>
