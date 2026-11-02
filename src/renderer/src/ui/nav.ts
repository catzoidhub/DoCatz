import { computed, ref, watch } from 'vue';
import { containerTab, openContainer, openProject, projectTab, section, settingsTab, type ContainerTab, type ProjectTab, type Section } from '../store';

/**
 * Back / forward through the screens seen in this window, like a browser (Catzoid #58): the ‹ › buttons (right-click
 * lists them), ⌘[ / ⌘], the mouse's back / forward buttons, a three-finger swipe and Windows' browser keys. A screen
 * is a section, a container and its tab, or a Settings tab.
 */

interface Place {
  section: Section;
  container: string | null;
  /** A compose project's page (its tab in `tab`). */
  project?: string | null;
  tab: ContainerTab | string;
}
interface Entry extends Place {
  label: string;
  at: number;
}

const LIMIT = 50;
const backStack = ref<Entry[]>([]);
const forwardStack = ref<Entry[]>([]);
const here = ref<Entry | null>(null);

const NAMES: Record<Section, string> = { containers: 'Containers', images: 'Images', volumes: 'Volumes', networks: 'Networks', builds: 'Builds', monitoring: 'Monitoring', commands: 'Commands', engine: 'Engine', settings: 'Settings' };
const TAB_NAMES: Record<string, string> = { env: 'Environment', containers: 'Containers', monitoring: 'Monitoring', info: 'Info', logs: 'Logs', terminal: 'Terminal', files: 'Files', stats: 'Stats', general: 'General', domains: 'Domains', ai: 'AI', updates: 'Updates', about: 'About' };

function current(): Place {
  if (section.value === 'settings') return { section: 'settings', container: null, tab: settingsTab.value };
  if (section.value === 'containers' && openProject.value) return { section: 'containers', container: null, project: openProject.value, tab: projectTab.value };
  if (section.value === 'containers') return { section: 'containers', container: openContainer.value, tab: openContainer.value ? containerTab.value : '' };
  return { section: section.value, container: null, tab: '' };
}
const labelOf = (p: Place) => [NAMES[p.section], p.project, p.container, p.tab ? TAB_NAMES[p.tab] ?? p.tab : ''].filter(Boolean).join(' › ');
const same = (a: Place | null, b: Place) => !!a && a.section === b.section && a.container === b.container && (a.project ?? null) === (b.project ?? null) && a.tab === b.tab;

export const canBack = computed(() => backStack.value.length > 0);
export const canForward = computed(() => forwardStack.value.length > 0);
export const backList = computed(() => [...backStack.value].reverse());
export const forwardList = computed(() => [...forwardStack.value].reverse());

let moving = false;
watch([section, openContainer, containerTab, openProject, projectTab, settingsTab], () => {
  if (moving) return;
  const p = current();
  if (same(here.value, p)) return;
  if (here.value) backStack.value = [...backStack.value, here.value].slice(-LIMIT);
  forwardStack.value = [];
  here.value = { ...p, label: labelOf(p), at: Date.now() };
});

function show(p: Place): void {
  moving = true;
  section.value = p.section;
  if (p.section === 'settings') settingsTab.value = p.tab as typeof settingsTab.value;
  if (p.section === 'containers') {
    openProject.value = p.project ?? null;
    if (p.project && p.tab) projectTab.value = p.tab as ProjectTab;
    openContainer.value = p.container;
    if (p.container && p.tab) containerTab.value = p.tab as ContainerTab;
  }
  setTimeout(() => (moving = false));
}

/** Moves `steps` back (negative) or forward. */
export function go(steps: number): void {
  const from = steps < 0 ? backStack : forwardStack;
  const to = steps < 0 ? forwardStack : backStack;
  const n = Math.min(Math.abs(steps), from.value.length);
  if (!n || !here.value) return;
  const taken = from.value.slice(from.value.length - n).reverse();
  from.value = from.value.slice(0, from.value.length - n);
  to.value = [...to.value, here.value, ...taken.slice(0, n - 1)].slice(-LIMIT);
  here.value = taken[n - 1];
  show(here.value);
}
export const back = () => go(-1);
export const forward = () => go(1);
