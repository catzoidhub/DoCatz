<script setup lang="ts">
import { computed, ref } from 'vue';
import { currentOS } from '@shared/platform';
import { api, attempt, containers, engine, notify } from '../store';
import DcNavButtons from './DcNavButtons.vue';
import ServiceMark from './ServiceMark.vue';

/**
 * Commands (as OrbStack's): the command lines worth knowing with DoCatz, ready to copy or run in a terminal — using
 * the engine from any terminal, compose, a shell in a container or in the VM, builds for other chips, cleaning up.
 * The container commands follow the container picked at the top.
 */
const isWin = currentOS === 'windows';
const terminalName = isWin ? 'PowerShell' : 'Terminal';
const picked = ref<string>('');
const running = computed(() => containers.value.filter((c) => c.state === 'running'));
const target = computed(() => running.value.find((c) => c.name === picked.value) ?? running.value[0] ?? null);
const name = computed(() => target.value?.name ?? '<container>');
const host = computed(() => engine.value?.dockerHost ?? (isWin ? 'npipe:////./pipe/docatz_engine' : 'unix://$HOME/.docatz/run/docker.sock'));
const url = computed(() => target.value?.url ?? 'https://web.shop.docatz.localhost');

interface Cmd {
  title: string;
  cmd: string;
  note?: string;
}
const groups = computed<{ title: string; hint: string; icon: string; items: Cmd[] }[]>(() => [
  {
    title: 'Use DoCatz from a terminal',
    hint: 'Your own docker CLI works too — it only needs to point at DoCatz.',
    icon: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11Zm3.22 2.72a.75.75 0 0 0 0 1.06L8.94 11l-2.72 2.72a.75.75 0 1 0 1.06 1.06l3.25-3.25a.75.75 0 0 0 0-1.06L7.28 7.22a.75.75 0 0 0-1.06 0ZM11 13.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z',
    items: [
      { title: 'Make DoCatz the default engine', cmd: 'docker context use docatz', note: 'Back to the previous one: docker context use default (or orbstack, desktop-linux …).' },
      { title: 'One command on DoCatz only', cmd: 'docker --context docatz ps' },
      { title: 'This terminal only', cmd: isWin ? `$env:DOCKER_HOST = "${host.value}"` : `export DOCKER_HOST=${host.value}` },
      { title: 'Which engine am I talking to?', cmd: 'docker context ls && docker info --format "{{.Name}} · {{.OperatingSystem}}"' },
    ],
  },
  {
    title: 'Compose',
    hint: 'Run from the project folder. DoCatz gives each service https://<service>.<project>.docatz.<tld>.',
    icon: 'M3.196 12.87l-.825.483a.75.75 0 0 0 0 1.294l7.25 4.25a.75.75 0 0 0 .758 0l7.25-4.25a.75.75 0 0 0 0-1.294l-.825-.484-5.666 3.322a2.25 2.25 0 0 1-2.276 0L3.196 12.87ZM10.38 1.103a.75.75 0 0 0-.76 0l-7.25 4.25a.75.75 0 0 0 0 1.294l7.25 4.25a.75.75 0 0 0 .76 0l7.25-4.25a.75.75 0 0 0 0-1.294l-7.25-4.25Z',
    items: [
      { title: 'Build & Up', cmd: 'docker compose up -d --build' },
      { title: 'Follow the logs', cmd: 'docker compose logs -f --tail=100' },
      { title: 'Recreate after a .env change', cmd: 'docker compose up -d --force-recreate' },
      { title: 'Down (volumes stay)', cmd: 'docker compose down' },
    ],
  },
  {
    title: 'Inside a container',
    hint: 'About the container picked at the top.',
    icon: 'M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 13.5v-7ZM6 7a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 6 7Zm2.75.75a.75.75 0 0 1 1.5 0v4.5a.75.75 0 0 1-1.5 0v-4.5ZM14 7a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 14 7Z',
    items: [
      { title: 'A shell', cmd: `docker exec -it ${name.value} sh` },
      { title: 'Its logs', cmd: `docker logs -f --tail=200 ${name.value}` },
      { title: 'Copy a file out', cmd: `docker cp ${name.value}:/path/in/container ./` },
      { title: 'Its domain', cmd: `curl -I ${url.value}` },
    ],
  },
  {
    title: 'The Linux VM',
    hint: isWin ? 'The WSL distro DoCatz runs Docker in.' : 'The Lima VM DoCatz runs Docker in (virtiofs mounts of your home folder).',
    icon: 'M7 2a1 1 0 0 1 1 1v1h4V3a1 1 0 1 1 2 0v1h.5A2.5 2.5 0 0 1 17 6.5V7h1a1 1 0 1 1 0 2h-1v2h1a1 1 0 1 1 0 2h-1v.5a2.5 2.5 0 0 1-2.5 2.5H14v1a1 1 0 1 1-2 0v-1H8v1a1 1 0 1 1-2 0v-1h-.5A2.5 2.5 0 0 1 3 13.5V13H2a1 1 0 1 1 0-2h1V9H2a1 1 0 1 1 0-2h1v-.5A2.5 2.5 0 0 1 5.5 4H6V3a1 1 0 0 1 1-1Z',
    items: isWin
      ? [{ title: 'A shell in the distro', cmd: 'wsl -d docatz' }]
      : [
          { title: 'A shell in the VM', cmd: 'LIMA_HOME=~/.docatz/vm ~/.docatz/lima/bin/limactl shell docatz' },
          { title: 'Its state', cmd: 'LIMA_HOME=~/.docatz/vm ~/.docatz/lima/bin/limactl list' },
        ],
  },
  {
    title: 'Builds',
    hint: 'Every build shows up in Builds, with its log.',
    icon: 'M11.98 1.8a1 1 0 0 1 .87 1.16L12.2 7H16a1 1 0 0 1 .78 1.63l-7 8.6a1 1 0 0 1-1.76-.8L8.67 12.6H5a1 1 0 0 1-.78-1.63l7-8.82a1 1 0 0 1 .76-.35Z',
    items: [
      { title: 'Build an image', cmd: 'docker build -t my-app .' },
      { title: isWin ? 'For x64 and ARM PCs' : 'For Intel and Apple silicon', cmd: 'docker buildx build --platform linux/amd64,linux/arm64 -t my-app .' },
      { title: isWin ? 'Run an x64 (amd64) image' : 'Run an Intel image', cmd: 'docker run --rm --platform linux/amd64 alpine uname -m', note: engine.value?.host.rosetta ? 'Fast through Rosetta (Engine → Rosetta for Intel images).' : undefined },
    ],
  },
  {
    title: 'Clean up',
    hint: 'DoCatz shows what goes before it removes anything (Images, Volumes, Engine → Disk usage).',
    icon: 'M8.75 1A2.75 2.75 0 0 0 6 3.75v.44c-.8.08-1.59.18-2.38.3a.75.75 0 1 0 .23 1.48l.15-.02.84 10.52A2.75 2.75 0 0 0 7.58 19h4.84a2.75 2.75 0 0 0 2.74-2.53l.84-10.52.15.02a.75.75 0 0 0 .23-1.48c-.79-.12-1.58-.22-2.38-.3v-.44A2.75 2.75 0 0 0 11.25 1h-2.5Z',
    items: [
      { title: 'What takes space', cmd: 'docker system df' },
      { title: 'Stopped containers, unused networks, dangling images', cmd: 'docker system prune' },
      { title: 'The build cache', cmd: 'docker builder prune' },
    ],
  },
]);

function copy(cmd: string) {
  void navigator.clipboard.writeText(cmd);
  notify('success', 'Copied');
}
const run = (cmd: string) => attempt(() => api.runInTerminal(cmd));
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="drag win-top flex h-14 shrink-0 items-end gap-3 border-b border-base-300/60 px-4 pb-2">
      <div class="no-drag"><DcNavButtons /></div>
      <div class="min-w-0 flex-1 pb-0.5"><h1 class="text-base font-semibold tracking-tight">Commands</h1><p class="truncate text-xs opacity-55">Copy one, or run it in {{ terminalName }} — always on the DoCatz engine.</p></div>
      <label v-if="running.length" class="no-drag flex items-center gap-2 pb-0.5 text-xs" title="The container the “Inside a container” commands are about">
        <ServiceMark v-if="target" :container="target" size="sm" />
        <select :value="target?.name" class="select select-sm w-56" @change="picked = ($event.target as HTMLSelectElement).value">
          <option v-for="c in running" :key="c.id" :value="c.name">{{ c.project ? `${c.project} / ${c.service}` : c.name }}</option>
        </select>
      </label>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl space-y-4 px-6 py-5">
        <section v-for="g in groups" :key="g.title" class="card">
          <div class="flex items-center gap-2.5 border-b border-base-300/50 px-4 py-2.5">
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-[color-mix(in_oklch,var(--c-commands)_16%,transparent)] text-[var(--c-commands)]"><svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="g.icon" /></svg></span>
            <h2 class="text-sm font-semibold tracking-tight">{{ g.title }}</h2>
            <span class="min-w-0 truncate text-xs opacity-50" :title="g.hint">{{ g.hint }}</span>
          </div>
          <ul class="divide-y divide-base-300/40">
            <li v-for="c in g.items" :key="c.title" class="group grid grid-cols-[13.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 transition-colors hover:bg-base-200/40">
              <span class="truncate text-[13px]" :title="c.note ? `${c.title} — ${c.note}` : c.title">{{ c.title }}<span v-if="c.note" class="ml-1 cursor-help opacity-40" title="">ⓘ</span></span>
              <code class="selectable min-w-0 truncate rounded-md bg-base-200/70 px-2.5 py-1 font-mono text-[12px]" :title="c.cmd">{{ c.cmd }}</code>
              <span class="flex items-center gap-1">
                <button class="btn btn-ghost btn-xs btn-square" title="Copy to the clipboard" @click="copy(c.cmd)">
                  <svg viewBox="0 0 20 20" class="size-3.5" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" /><path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" /></svg>
                </button>
                <button class="btn btn-xs btn-primary gap-1" :title="`Open ${terminalName} and run it on the DoCatz engine`" @click="run(c.cmd)">
                  <svg viewBox="0 0 20 20" class="size-3" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.86l8.2-4.9a1 1 0 0 0 0-1.72l-8.2-4.9a1 1 0 0 0-.2-.04Z" /></svg>
                  Run
                </button>
              </span>
            </li>
          </ul>
        </section>
        <p class="px-1 text-xs opacity-50">Run opens {{ terminalName }} with DoCatz’s docker first on PATH and the <span class="font-mono">docatz</span> context, so a command never lands on another engine. Hover a command to see all of it.</p>
      </div>
    </div>
  </section>
</template>
