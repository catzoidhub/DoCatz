import { DC_ASK_DESTRUCTIVE, type DcAskAction, type DcPruneKind } from '@shared/types';
import { api, containerTab, containers, openContainer, saveSettings, section, settingsTab, token, type Section } from '../store';

/**
 * Ask DoCatz's steps (Catzoid #58): each runs only when the user clicks it, after a check that what it names exists.
 * Destructive ones (remove a container, compose down, prune) are reviewed first and need a name typed — the window's
 * own Review box (AskDocatz.vue) does that before runAsk is called.
 */

const PRUNE: DcPruneKind[] = ['containers', 'images', 'volumes', 'networks', 'build-cache'];
const SECTIONS: Section[] = ['containers', 'images', 'volumes', 'networks', 'engine'];

function container(name: string | undefined) {
  const c = containers.value.find((x) => x.name === name);
  if (!c) throw new Error(`No container called ${name ?? '(none)'} — the engine may be stopped or it was removed`);
  return c;
}
function project(name: string | undefined) {
  if (!name || !containers.value.some((c) => c.project === name)) throw new Error(`No compose project called ${name ?? '(none)'}`);
  return name;
}

export async function runAsk(a: DcAskAction): Promise<string> {
  const x = a.args;
  switch (a.kind) {
    case 'start-container':
    case 'stop-container':
    case 'restart-container': {
      const c = container(x.container);
      await api.containerAction(c.id, a.kind.split('-')[0] as 'start' | 'stop' | 'restart');
      return `${c.name}: ${a.kind.split('-')[0]} done`;
    }
    case 'remove-container': {
      const c = container(x.container);
      await api.containerRemove(c.id, false);
      return `${c.name} removed`;
    }
    case 'open-container':
    case 'open-logs':
    case 'open-terminal': {
      const c = container(x.container);
      section.value = 'containers';
      openContainer.value = c.name;
      containerTab.value = a.kind === 'open-logs' ? 'logs' : a.kind === 'open-terminal' ? 'terminal' : 'info';
      return `${c.name} open`;
    }
    case 'open-url': {
      const c = container(x.container);
      if (!c.url) throw new Error(`${c.name} publishes no port, so it has no domain`);
      await api.openUrl(c.url);
      return `Opened ${c.url}`;
    }
    case 'compose-up':
    case 'compose-down':
    case 'compose-restart': {
      const p = project(x.project);
      const action = a.kind.slice(8) as 'up' | 'down' | 'restart';
      await api.composeProject(p, action, token());
      return `${p}: compose ${action} started`;
    }
    case 'start-engine':
      await api.engineStart();
      return 'The engine is running';
    case 'stop-engine':
      await api.engineStop();
      return 'The engine stopped';
    case 'prune': {
      const kind = x.what as DcPruneKind;
      if (!PRUNE.includes(kind)) throw new Error(`Unknown clean-up: ${x.what}`);
      const r = await api.prune(kind);
      return `${r.removed} removed`;
    }
    case 'pull-image':
      if (!x.image) throw new Error('Which image?');
      await api.imagePull(x.image, token());
      return `Pulling ${x.image}`;
    case 'open-section':
      if (!SECTIONS.includes(x.section as Section)) throw new Error(`Unknown section ${x.section}`);
      section.value = x.section as Section;
      return `${x.section} open`;
    case 'set-theme':
      if (!['system', 'light', 'dark'].includes(x.theme ?? '')) throw new Error(`Unknown theme ${x.theme}`);
      await saveSettings({ theme: x.theme as 'system' | 'light' | 'dark' });
      return `Theme: ${x.theme === 'system' ? 'Auto' : x.theme}`;
    case 'open-settings':
      settingsTab.value = (['general', 'domains', 'ai', 'updates', 'about'].includes(x.tab ?? '') ? x.tab : 'general') as typeof settingsTab.value;
      section.value = 'settings';
      return 'Settings open';
  }
}

export const askRisk = (a: DcAskAction): 'danger' | null => (DC_ASK_DESTRUCTIVE.includes(a.kind) ? 'danger' : null);

/** The word the user types to let a destructive step run. */
export function askWord(a: DcAskAction): string {
  if (a.kind === 'remove-container') return a.args.container ?? '';
  if (a.kind === 'compose-down') return a.args.project ?? '';
  return 'delete';
}

/** What a risky step does, in plain words, before it may continue (the Review box). */
export function askConsequence(a: DcAskAction): string {
  const x = a.args;
  switch (a.kind) {
    case 'remove-container':
      return `Removes the container ${x.container} and the files inside it. Its image and named volumes stay. There is no undo.`;
    case 'compose-down':
      return `Stops and removes every container and network of ${x.project}. Its volumes (your data) stay; Up brings it back.`;
    case 'prune':
      return `Removes the ${x.what === 'build-cache' ? 'build cache' : `unused ${x.what}`} listed below.${x.what === 'volumes' ? ' The data inside those volumes is gone for good.' : ''}`;
    default:
      return a.label;
  }
}

/** The step's target in a few words, under its label. */
export function askDetail(a: DcAskAction): string {
  const x = a.args;
  return [x.container, x.project && `project ${x.project}`, x.what, x.image, x.section, x.tab, x.theme].filter(Boolean).join(' · ');
}
