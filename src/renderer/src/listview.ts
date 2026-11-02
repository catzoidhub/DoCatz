import { computed, ref, watch } from 'vue';
import type { MenuItem } from './components/PopMenu.vue';

/**
 * Sort and group-by of the project list (as DevCatz's sidebar): the drag-and-drop order and the user's groups
 * ("default"), or by name / no groups; and Running only. Remembered in localStorage (a convenience, not a setting).
 */
export type ListSort = 'default' | 'name';
export type ListGroup = 'default' | 'none';
export interface ListView {
  sort: ListSort;
  group: ListGroup;
  /** Folded sections that are not the user's groups (favorites, the rest), by key. */
  collapsed: string[];
  runningOnly: boolean;
}

export function useListView(key: string) {
  const view = ref<ListView>({ sort: 'default', group: 'default', collapsed: [], runningOnly: false });
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '') as Partial<ListView>;
    if (v.sort === 'default' || v.sort === 'name') view.value.sort = v.sort;
    if (v.group === 'default' || v.group === 'none') view.value.group = v.group;
    if (Array.isArray(v.collapsed)) view.value.collapsed = v.collapsed.filter((x) => typeof x === 'string');
    view.value.runningOnly = v.runningOnly === true;
  } catch {
    /* first run */
  }
  watch(view, (v) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* only a convenience */
    }
  }, { deep: true });

  /** The ⇅ menu. */
  const items = computed<MenuItem[]>(() => [
    { label: 'Running only', checked: view.value.runningOnly, action: () => (view.value.runningOnly = !view.value.runningOnly) },
    { label: 'Sort by default (drag & drop order)', separator: true, checked: view.value.sort === 'default', action: () => (view.value.sort = 'default') },
    { label: 'Sort by name', checked: view.value.sort === 'name', action: () => (view.value.sort = 'name') },
    { label: 'Group by default (your groups)', separator: true, checked: view.value.group === 'default', action: () => (view.value.group = 'default') },
    { label: 'No grouping', checked: view.value.group === 'none', action: () => (view.value.group = 'none') },
  ]);
  const custom = computed(() => view.value.sort !== 'default' || view.value.group !== 'default' || view.value.runningOnly);
  const isCollapsed = (k: string) => view.value.collapsed.includes(k);
  const toggle = (k: string) => (view.value.collapsed = isCollapsed(k) ? view.value.collapsed.filter((x) => x !== k) : [...view.value.collapsed, k]);
  return { view, items, custom, isCollapsed, toggle };
}
