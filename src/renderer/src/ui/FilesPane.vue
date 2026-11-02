<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { DcContainer } from '@shared/types';
import { api, attempt, bytes, errorText, notify } from '../store';

/** The files inside a running container (DoCatz TODO #13): browse folders, save a file or folder to the host (.tar). */
const props = defineProps<{ container: DcContainer }>();
type Entry = { name: string; dir: boolean; link: boolean; size: number; mode: string; mtime: string };
const path = ref('/');
const entries = ref<Entry[]>([]);
const loading = ref(false);
const error = ref('');

async function load(p = path.value) {
  if (props.container.state !== 'running') {
    error.value = 'Start the container to browse its files.';
    entries.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    entries.value = await api.files(props.container.id, p);
    path.value = p;
  } catch (e) {
    error.value = errorText(e);
  }
  loading.value = false;
}
onMounted(() => load('/'));
watch(() => props.container.id, () => load('/'));
const join = (name: string) => `${path.value.replace(/\/$/, '')}/${name}`;
const up = () => load(path.value.replace(/\/[^/]+\/?$/, '') || '/');
const crumbs = () => {
  const parts = path.value.split('/').filter(Boolean);
  return [{ label: '/', path: '/' }, ...parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join('/')}` }))];
};
async function save(name: string) {
  const file = await attempt(() => api.fileSave(props.container.id, join(name)));
  if (file) notify('success', `Saved to ${file.split(/[\\/]/).pop()}`);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex shrink-0 items-center gap-1 border-b border-base-300/60 px-4 py-2 text-sm">
      <button class="btn btn-ghost btn-xs btn-square" :disabled="path === '/'" title="Up" @click="up">↑</button>
      <template v-for="(c, i) in crumbs()" :key="c.path">
        <span v-if="i > 1" class="opacity-30">/</span>
        <button class="btn btn-ghost btn-xs font-mono" @click="load(c.path)">{{ c.label }}</button>
      </template>
      <span class="flex-1" />
      <span v-if="loading" class="loading loading-spinner loading-xs" />
      <button class="btn btn-ghost btn-xs" @click="load()">Refresh</button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="error" class="px-4 py-6 text-sm opacity-60">{{ error }}</p>
      <table v-else class="table table-sm">
        <thead><tr><th>Name</th><th class="w-24 text-right">Size</th><th class="w-32">Modified</th><th class="w-28">Mode</th><th class="w-16" /></tr></thead>
        <tbody>
          <tr v-for="e in entries" :key="e.name" class="group hover:bg-base-200/50" @dblclick="e.dir && load(join(e.name))">
            <td class="font-mono text-xs">
              <a v-if="e.dir" class="link-hover cursor-pointer font-medium" @click="load(join(e.name))">{{ e.name }}/</a>
              <span v-else>{{ e.name }}<span v-if="e.link" class="opacity-40"> →</span></span>
            </td>
            <td class="text-right text-xs tabular-nums opacity-70">{{ e.dir ? '' : bytes(e.size) }}</td>
            <td class="text-xs opacity-60">{{ e.mtime }}</td>
            <td class="font-mono text-[11px] opacity-50">{{ e.mode }}</td>
            <td class="text-right"><button class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100" title="Save to this computer as .tar" @click="save(e.name)">Save</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
