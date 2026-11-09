import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { DcContainer, EngineState } from '@shared/types';
import { isWin } from './platform';

/** Windows and Linux: the coloured icon (a black template glyph would vanish on a dark taskbar or panel). */
const colour = process.platform !== 'darwin';

/**
 * The menu bar / system tray (DoCatz TODO #16): the engine's state, Start / Stop, the running containers (grouped by
 * compose project) with their URL and Open in DoCatz, and the window. Rebuilt when the engine or the list changes.
 */

export interface TrayActions {
  open(route?: string): void;
  start(): void;
  stop(): void;
  quit(): void;
}

const STATUS: Record<string, string> = { running: 'Running', stopped: 'Stopped', starting: 'Starting…', stopping: 'Stopping…', missing: 'Not set up yet', error: 'Needs attention', unsupported: 'Not available' };

export class DocatzTray {
  private tray: Tray | null = null;

  constructor(private actions: TrayActions) {}

  start(): void {
    const icon = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), colour ? 'tray.png' : 'trayTemplate.png'));
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    if (icon.isEmpty() && !colour) this.tray.setTitle('🐳');
    this.tray.setToolTip('DoCatz');
    this.update(null, []);
  }

  update(engine: EngineState | null, containers: DcContainer[]): void {
    if (!this.tray) return;
    const status = engine?.status ?? 'stopped';
    const running = containers.filter((c) => c.state === 'running');
    const groups = new Map<string, DcContainer[]>();
    for (const c of running) groups.set(c.project ?? '', [...(groups.get(c.project ?? '') ?? []), c]);
    const entry = (c: DcContainer): MenuItemConstructorOptions => ({
      label: c.project ? (c.service ?? c.name) : c.name,
      submenu: [
        ...(c.url ? [{ label: `Open ${c.url.replace(/^https?:\/\//, '')}`, click: () => void shell.openExternal(c.url!) }] : []),
        { label: 'Open in DoCatz', click: () => this.actions.open(`containers/${c.name}`) },
      ],
    });
    const items: MenuItemConstructorOptions[] = [
      { label: `Engine: ${STATUS[status] ?? status}`, enabled: false },
      status === 'running' || status === 'starting'
        ? { label: 'Stop Engine', enabled: status === 'running', click: () => this.actions.stop() }
        : { label: status === 'missing' ? 'Set Up and Start Engine' : 'Start Engine', enabled: status !== 'unsupported' && status !== 'stopping', click: () => this.actions.start() },
      { type: 'separator' },
    ];
    if (running.length) {
      items.push({ label: `Running (${running.length})`, enabled: false });
      for (const [project, list] of groups) {
        if (project) items.push({ label: project, submenu: list.map(entry) });
        else items.push(...list.map(entry));
      }
      items.push({ type: 'separator' });
    }
    items.push({ label: 'Open DoCatz', click: () => this.actions.open() }, { label: 'Settings…', click: () => this.actions.open('settings') }, { type: 'separator' }, { label: isWin ? 'Exit DoCatz' : 'Quit DoCatz', click: () => this.actions.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setToolTip(`DoCatz — engine ${(STATUS[status] ?? status).toLowerCase()}${running.length ? `, ${running.length} running` : ''}`);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
