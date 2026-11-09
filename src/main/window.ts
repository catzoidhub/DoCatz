import { app, BrowserWindow, Menu, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { isLinux, isWin } from './platform';

/** Windows and Linux: the page draws its own title strip with the system buttons over its right end (no traffic lights). */
const overlay = isWin || isLinux;

/**
 * The DoCatz window (one) and the app menu. Menu items reach the window as `app:command`. On Windows the window has
 * no menu bar (title bar overlay): the ☰ button opens the same menu and unhandled shortcuts run its items (as DBCatz).
 * Linux (#101) does the same, as DevCatz does there (macOS's inset traffic lights would leave it without window buttons).
 */

let win: BrowserWindow | null = null;
const preload = join(__dirname, '../preload/index.js');

export type AppCommand =
  | 'section:containers'
  | 'section:images'
  | 'section:volumes'
  | 'section:networks'
  | 'section:builds'
  | 'section:monitoring'
  | 'section:commands'
  | 'section:engine'
  | 'openCompose'
  | 'engineStart'
  | 'engineStop'
  | 'engineRestart'
  | 'refresh'
  | 'find'
  | 'settings'
  | 'about'
  | 'checkUpdates'
  | 'reportBug'
  | 'sendFeedback'
  | 'askDocatz'
  | 'navBack'
  | 'navForward';

export function send(command: AppCommand, arg?: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('app:command', { command, arg });
}

function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  // Linux (GNOME): the buttons bring their own round grey backgrounds, so no strip behind them (as DevCatz).
  if (isLinux) return { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e5e7eb' : '#1f2937', height: 48 };
  return nativeTheme.shouldUseDarkColors ? { color: '#2b2d34', symbolColor: '#e5e7eb', height: 48 } : { color: '#e7e8ec', symbolColor: '#1f2937', height: 48 };
}
if (overlay) nativeTheme.on('updated', () => win && !win.isDestroyed() && win.setTitleBarOverlay(titleBarOverlay()));

/** Opens (or brings forward) the window; `route` is a place in it (containers/<name>, engine, settings/about …). */
export function openWindow(route?: string): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (route) win.webContents.send('app:open', route);
    return;
  }
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 880,
    minHeight: 540,
    title: 'DoCatz',
    ...(overlay
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: titleBarOverlay(), backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1f24' : '#f6f7f9' }
      : { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 }, backgroundColor: '#00000000', vibrancy: 'sidebar' as const }),
    show: false,
    webPreferences: { preload, sandbox: false, contextIsolation: true },
  });
  const w = win;
  w.once('ready-to-show', () => w.show());
  w.webContents.on('render-process-gone', (_e, d) => console.error(`DoCatz renderer gone: ${d.reason} (exit ${d.exitCode})`));
  w.on('swipe', (_e, direction) => {
    if (direction === 'right') send('navBack');
    else if (direction === 'left') send('navForward');
  });
  w.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') send('navBack');
    else if (cmd === 'browser-forward') send('navForward');
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  const hash = route ? `route=${encodeURIComponent(route)}` : '';
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash });
}

export const mainWindow = () => (win && !win.isDestroyed() ? win : null);

const item = (label: string, command: AppCommand, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({ label, accelerator, click: () => (openWindow(), send(command)), ...extra });
const sep: MenuItemConstructorOptions = { type: 'separator' };

let updateLabel = 'Check for Updates…';
export function setUpdateLabel(label: string): void {
  if (label === updateLabel) return;
  updateLabel = label;
  applyMenu();
}

function template(): MenuItemConstructorOptions[] {
  return [
    {
      label: app.name,
      submenu: overlay
        ? [item('About DoCatz', 'about'), item(updateLabel, 'checkUpdates'), sep, item('Settings…', 'settings', 'CmdOrCtrl+,'), sep, { role: 'quit', label: 'Exit' }]
        : [item('About DoCatz', 'about'), item(updateLabel, 'checkUpdates'), sep, item('Settings…', 'settings', 'CmdOrCtrl+,'), sep, { role: 'services' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }],
    },
    { label: 'File', submenu: [item('Open Compose File…', 'openCompose', 'CmdOrCtrl+O'), sep, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'delete' }, { role: 'selectAll' }, sep, item('Find…', 'find', 'CmdOrCtrl+F')] },
    { role: 'viewMenu' },
    {
      label: 'Engine',
      submenu: [item('Start', 'engineStart'), item('Stop', 'engineStop'), item('Restart', 'engineRestart'), sep, item('Refresh', 'refresh', 'CmdOrCtrl+R'), sep, item('Ask DoCatz…', 'askDocatz', 'CmdOrCtrl+K')],
    },
    {
      label: 'Go',
      submenu: [
        item('Containers', 'section:containers', 'CmdOrCtrl+1'),
        item('Images', 'section:images', 'CmdOrCtrl+2'),
        item('Volumes', 'section:volumes', 'CmdOrCtrl+3'),
        item('Networks', 'section:networks', 'CmdOrCtrl+4'),
        item('Builds', 'section:builds', 'CmdOrCtrl+5'),
        item('Engine', 'section:engine', 'CmdOrCtrl+6'),
        sep,
        item('Monitoring', 'section:monitoring', 'CmdOrCtrl+7'),
        item('Commands', 'section:commands', 'CmdOrCtrl+8'),
        sep,
        item('Back', 'navBack', 'CmdOrCtrl+['),
        item('Forward', 'navForward', 'CmdOrCtrl+]'),
      ],
    },
    { role: 'windowMenu', submenu: overlay ? [{ role: 'minimize' }] : [{ role: 'minimize' }, { role: 'zoom' }, sep, { role: 'front' }] },
    { role: 'help', submenu: [item('Report a Bug…', 'reportBug'), item('Send Feedback…', 'sendFeedback')] },
  ];
}

export function applyMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
}

export function appMenuPopup(x: number, y: number): void {
  const w = mainWindow();
  if (w) Menu.getApplicationMenu()?.popup({ window: w, x: Math.round(x), y: Math.round(y) });
}

const order = (p: string) => ['ctrl', 'alt', 'shift'].indexOf(p) + 1 || 9;
/** "CmdOrCtrl+Shift+N" → "ctrl+shift+n" (the form the window builds from a key press). */
const normal = (acc: string) =>
  acc
    .split('+')
    .map((p) => p.toLowerCase())
    .map((p) => (p === 'cmdorctrl' || p === 'commandorcontrol' || p === 'control' ? 'ctrl' : p === 'return' ? 'enter' : p === 'option' ? 'alt' : p))
    .sort((a, b) => order(a) - order(b))
    .join('+');

function menuItems(): { key: string; item: Electron.MenuItem }[] {
  const out: { key: string; item: Electron.MenuItem }[] = [];
  const walk = (m: Electron.Menu) =>
    m.items.forEach((i) => {
      if (i.submenu) walk(i.submenu);
      else if (i.accelerator && !i.role && i.visible !== false) out.push({ key: normal(String(i.accelerator)), item: i });
    });
  const m = Menu.getApplicationMenu();
  if (m) walk(m);
  return out;
}
export const menuShortcuts = (): string[] => [...new Set(menuItems().map((x) => x.key))];
export function menuKey(key: string): void {
  const w = mainWindow();
  const hit = menuItems().find((x) => x.key === key && x.item.enabled);
  if (w && hit) hit.item.click(undefined, w, w.webContents);
}
