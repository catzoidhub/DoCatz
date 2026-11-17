<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, attempt, engine, mcatzpInstalling, runs, siblingTask, update, updateOpen, updateOpenAuto } from '../store';

/**
 * DoCatz's own update opens What's New by itself (Catzoid #97, as DevCatz). Once per version and launch, at a calm
 * moment: the window in front, no other dialog open (the welcome included), nothing starting or installing. Later =
 * again on the next launch, or 24 h after it last opened in a long session; Skip this version = never for that
 * version; "Don't open this on its own" (in the dialog, and Settings → Updates) leaves only the dot, Settings and the
 * notification. A finished download opens it once more for Restart now.
 */
const DAY = 86_400_000;
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 30_000);
const wake = () => (now.value = Date.now());
window.addEventListener('focus', wake);
document.addEventListener('visibilitychange', wake);
onBeforeUnmount(() => {
  clearInterval(tick);
  window.removeEventListener('focus', wake);
  document.removeEventListener('visibilitychange', wake);
});

/** What was opened in this launch: `<version>:available` / `<version>:downloaded`. */
const shown = new Set<string>();

/** What would open now (null = nothing to ask). */
const want = computed(() => {
  const u = update.value;
  if (!u?.version || !u.settings.dialog || u.settings.skipped === u.version) return null;
  if (u.status === 'downloaded') return `${u.version}:downloaded`;
  if (u.status === 'available') return `${u.version}:available`;
  return null;
});
/** Something is running that a dialog on top would interrupt. */
const busy = computed(
  () =>
    ['starting', 'stopping'].includes(engine.value?.status ?? '') ||
    !!(siblingTask.value && !siblingTask.value.done) ||
    !!mcatzpInstalling.value ||
    Object.values(runs.value).some((r) => !r.done),
);

watch(
  [want, busy, now],
  () => {
    const key = want.value;
    if (!key || updateOpen.value || busy.value) return;
    const again = (update.value?.settings.promptAt ?? 0) + DAY <= now.value;
    if (shown.has(key) && !again) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (document.querySelector('dialog[open], .modal-open')) return;
    shown.add(key);
    updateOpenAuto.value = true;
    updateOpen.value = true;
    void attempt(() => api.updateConfigure({ promptAt: Date.now() }));
  },
  { immediate: true },
);
watch(updateOpen, (open) => {
  if (!open) updateOpenAuto.value = false;
});
</script>

<template>
  <span hidden />
</template>
