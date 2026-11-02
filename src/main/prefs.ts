import type { DcProjectPrefs } from '@shared/types';
import { store } from './store';

/**
 * How the user arranges the project list (as DevCatz's sites): favorites, their own groups (each with its projects and
 * whether it is folded) and the drag-and-drop order. Kept in DoCatz's config; projects are named as compose names them.
 */

const KEY = 'projectPrefs';
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function projectPrefs(): DcProjectPrefs {
  const s = store.extra<Partial<DcProjectPrefs>>(KEY) ?? {};
  const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && NAME.test(x)))] : []);
  return {
    favorites: names(s.favorites),
    order: names(s.order),
    groups: (Array.isArray(s.groups) ? s.groups : [])
      .filter((g) => g && typeof g.name === 'string' && g.name.trim())
      .map((g) => ({ name: g.name.trim().slice(0, 60), projects: names(g.projects), collapsed: g.collapsed === true })),
  };
}

/** Replaces the arrangement (checked: known shapes only; a project sits in at most one group). */
export function setProjectPrefs(next: DcProjectPrefs): DcProjectPrefs {
  store.setExtra(KEY, next);
  const p = projectPrefs();
  const seen = new Set<string>();
  const groups = p.groups
    .filter((g, i, all) => all.findIndex((x) => x.name.toLowerCase() === g.name.toLowerCase()) === i)
    .map((g) => ({ ...g, projects: g.projects.filter((x) => !seen.has(x) && (seen.add(x), true)) }));
  const clean = { ...p, groups };
  store.setExtra(KEY, clean);
  return clean;
}
