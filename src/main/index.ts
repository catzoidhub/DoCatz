import { app, dialog, ipcMain, shell } from 'electron';
import { createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import { API_METHODS, type DcContainer, type DoCatzApi, type SiblingApp } from '@shared/types';
import { AskAi } from './ai';
import { buildDetail, buildLogs, listBuilds, removeBuild } from './builds';
import { envCreate, envRead, envRemove, envSetLocked, envState, envWrite } from './envs';
import { writeBridge } from './bridge';
import { removeContext, setPath as setCliPath } from './cli';
import { findCatzoidApp, openCatzoidApp, platformId } from './companion';
import { DockerError } from './docker/client';
import * as ops from './docker/ops';
import { Domains } from './domains';
import { Engine } from './engine';
import { Reporter } from './reporter';
import { projects, Runs } from './runs';
import { applySettings, migrateToShared, setAiKey, setSettings, settings } from './settings';
import { siteBase } from './shared';
import { DocatzTray } from './tray';
import { uninstallPlan, uninstallRun } from './uninstall';
import { Updater } from './updater';
import { appMenuPopup, applyMenu, mainWindow, menuKey, menuShortcuts, openWindow, setUpdateLabel } from './window';

/**
 * DoCatz — a fast, light Docker engine and container manager, the fourth Catzoid app. Standalone; next to DevCatz,
 * DBCatz and DialCatz it shares the theme, the AI connection, the site address and the domains, and publishes its
 * containers in bridge.json. Links:
 *   docatz://open[?site=<DevCatz site id>]               the window (Containers)
 *   docatz://container/<name>                            a container's page
 *   docatz://compose?path=<file>[&site=<DevCatz site>]   that compose project: its containers when it runs, and the
 *                                                        compose file ready to Up / rebuild (never run by the link)
 */

const engine = new Engine();
const domains = new Domains();
ops.setDomainNameLookup(domains.nameOf);
const runs = new Runs();
const updater = new Updater();
const reporter = new Reporter();
const tray = new DocatzTray({
  open: (route) => openWindow(route),
  start: () => void engine.start().catch((e) => console.warn('engine start:', (e as Error).message)),
  stop: () => void engine.stop().catch((e) => console.warn('engine stop:', (e as Error).message)),
  quit: () => app.quit(),
});
let containers: DcContainer[] = [];
const ai = new AskAi({ containers: () => ops.listContainers(domains.urlFor), container: (id) => ops.containerDetail(id, domains.urlFor), engine: () => engine.state() });

const send = (channel: string, payload: unknown) => mainWindow()?.webContents.send(channel, payload);

// ---------------------------------------------------------------- the list, kept fresh by engine events

let refreshing: Promise<void> | null = null;
let refreshAgain = false;
async function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      containers = (await engine.up()) ? await ops.listContainers(domains.urlFor) : [];
    } catch {
      containers = [];
    }
    await domains.setRoutes(containers).catch((e) => console.warn('routes:', (e as Error).message));
    writeBridge(containers, containers.length || (await engine.up()) ? 'running' : 'stopped', { httpsPort: domains.httpsPort, httpPort: domains.httpPort });
    send('app:changed', null);
    tray.update(await engine.state().catch(() => null), containers);
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}

let stopEvents: (() => void) | null = null;
let eventTimer: ReturnType<typeof setTimeout> | null = null;
async function watchEvents(): Promise<void> {
  if (stopEvents) return;
  try {
    stopEvents = await ops.watchEvents(
      () => {
        if (eventTimer) return;
        eventTimer = setTimeout(() => {
          eventTimer = null;
          void refresh();
        }, 300);
      },
      () => {
        stopEvents = null;
        void refresh();
        // The engine went away (stopped, restarted): try again while it comes back.
        setTimeout(() => void engine.up().then((up) => (up ? watchEvents() : undefined)), 3000);
      },
    );
  } catch {
    stopEvents = null;
  }
}

engine.onChange = (s) => {
  send('app:engine', s);
  tray.update(s, containers);
};
engine.onUp = () => {
  void watchEvents();
  void refresh();
};
domains.onChange = () => void refresh();
domains.onState = (d) => send('app:domains', d);
runs.onChange = (r) => send('app:run', r);

// ---------------------------------------------------------------- logs and terminals

const follows = new Map<string, () => void>();
const terms = new Map<string, { socket: Duplex; exec: string }>();
let termSeq = 0;

// ---------------------------------------------------------------- links

function handleLink(raw: string): void {
  try {
    const u = new URL(raw);
    if (u.hostname === 'container') {
      const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!/^[\w.-]{1,200}$/.test(name)) throw new Error('bad container name');
      return openWindow(`containers/${name}`);
    }
    if (u.hostname === 'compose') {
      const path = u.searchParams.get('path') ?? '';
      if (!/\.(ya?ml)$/i.test(path) || path.length > 1000 || /[\u0000-\u001f]/.test(path)) throw new Error('bad compose path');
      return openWindow(`compose/${encodeURIComponent(path)}`);
    }
    openWindow('containers');
  } catch (e) {
    console.warn(`docatz link ignored: ${raw} (${(e as Error).message})`);
    openWindow();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('docatz://'));
  if (link) handleLink(link);
  else openWindow();
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (app.isReady()) handleLink(url);
  else app.once('ready', () => handleLink(url));
});
app.on('activate', () => openWindow());
// The engine and the menu bar stay when the window closes; Quit ends DoCatz (macOS keeps the VM running).
app.on('window-all-closed', () => undefined);
app.on('before-quit', () => {
  for (const stop of follows.values()) stop();
  for (const t of terms.values()) t.socket.destroy();
  stopEvents?.();
  domains.stop();
  engine.dispose();
  tray.destroy();
});

/** Plain words for the engine being off. */
function needEngine<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof DockerError && e.status === 0) throw new Error('The engine is not running — start it first');
    throw e;
  });
}

const siblingInfo: Record<SiblingApp, [string, string, string]> = {
  devcatz: ['DevCatz', 'devcatz', 'com.mrcatz.devcatz'],
  dbcatz: ['DBCatz', 'dbcatz', 'com.mrcatz.dbcatz'],
  dialcatz: ['DialCatz', 'dialcatz', 'com.mrcatz.dialcatz'],
};

function api(): DoCatzApi {
  const win = () => mainWindow() ?? undefined;
  return {
    appInfo: async () => {
      const found = await Promise.all((Object.keys(siblingInfo) as SiblingApp[]).map(async (k) => [k, await findCatzoidApp(...siblingInfo[k]).catch(() => null)] as const));
      return { version: app.getVersion(), site: siteBase(), platform: platformId() ?? '', siblings: Object.fromEntries(found) as Record<SiblingApp, string | null> };
    },
    aboutInfo: async () => ({ version: app.getVersion(), arch: process.arch, macos: process.getSystemVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, site: siteBase(), dataDir: app.getPath('userData') }),
    updateState: async () => updater.get(),
    updateCheck: async () => updater.check(true),
    updateDownload: async () => updater.download(),
    updateCancel: async () => updater.cancel(),
    updateSkip: async (version) => updater.skip(version),
    updateInstall: async (now) => updater.install(now),
    updateConfigure: async (patch) => updater.configure(patch),
    reportPreview: async (kind, message, email, shots) => reporter.preview(kind, message, email, Number(shots) || 0),
    reportSend: (kind, message, email, shots) => reporter.feedback(kind, message, email, Array.isArray(shots) ? shots : []),
    captureWindow: async () => {
      const w = win();
      return w && !w.isDestroyed() ? (await w.webContents.capturePage()).toPNG().toString('base64') : '';
    },
    reportError: async (message, stack) => reporter.error('renderer', Object.assign(new Error(message), { stack })),
    reportSettings: async () => reporter.settings(),
    reportConfigure: async (crash) => reporter.configure(crash),
    uninstallPlan: () => uninstallPlan(),
    uninstallRun: (confirm, shared) =>
      uninstallRun(confirm, shared, async () => {
        updater.stop();
        reporter.stop();
        for (const t of terms.values()) t.socket.destroy();
        stopEvents?.();
        await engine.reset('reset').catch((e) => console.warn('uninstall: VM not removed:', (e as Error).message));
        removeContext();
        await setCliPath(false).catch(() => undefined);
        await domains.uninstall();
        domains.stop();
      }),
    settings: async () => settings(),
    setSettings: async (patch) => setSettings(patch),
    setAiKey: async (provider, key) => setAiKey(provider, key),
    aiModels: (provider) => ai.models(provider),
    aiProbe: (provider, models) => ai.probe(provider, models),
    aiTest: () => ai.test(),
    aiCancel: async (token) => ai.cancel(token),
    aiAsk: (req, token) => ai.ask(req, token),
    aiPreviewAsk: (req) => ai.previewAsk(req),
    aiExplainLog: (req, token) => ai.explainLog(req, token),
    aiPreviewLog: (req) => ai.previewLog(req),
    aiFile: (req, token) => ai.file(req, token),
    aiPreviewFile: async (req) => ai.previewFile(req),
    openUrl: async (url) => {
      if (url === 'app:licenses') await shell.openPath(app.isPackaged ? join(process.resourcesPath, 'third-party-licenses.txt') : join(app.getAppPath(), 'resources', 'third-party-licenses.txt'));
      else if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
    },
    reveal: async (path) => shell.showItemInFolder(path),
    openSibling: async (which, link) => {
      const info = siblingInfo[which];
      if (!info || !link.startsWith(`${info[1]}://`)) throw new Error('Unknown app or link');
      const path = await findCatzoidApp(...info);
      if (!path) return false;
      await openCatzoidApp(path, link);
      return true;
    },

    engineState: () => engine.state(),
    engineStart: () => engine.start(),
    engineStop: () => engine.stop(),
    engineRestart: () => engine.restart(),
    engineReset: async (confirm) => {
      await engine.reset(confirm);
      void refresh();
    },
    engineConfigure: (patch) => engine.configure(patch),
    engineCancel: async () => engine.cancel(),
    engineLog: () => engine.log(),
    contextSet: (use) => engine.setContext(use),
    cliInstall: () => engine.installCli(),
    cliPath: (on) => engine.setPath(on),
    diskUsage: () => needEngine(() => ops.diskUsage()),

    containers: () => needEngine(() => ops.listContainers(domains.urlFor)),
    container: (id) => needEngine(() => ops.containerDetail(id, domains.urlFor)),
    containerEnv: (id) => needEngine(() => ops.containerEnv(id)),
    containerAction: (id, action) => needEngine(() => ops.containerAction(id, action)),
    containerRemove: (id, volumes) => needEngine(() => ops.containerRemove(id, volumes)),
    stats: (ids) => ops.stats(ids.slice(0, 60)),
    logsFollow: async (id, tail, token) => {
      follows.get(token)?.();
      const stop = await needEngine(() => ops.followLogs(id, Math.min(Math.max(tail, 0), 10_000), token, (c) => send('app:logs', c)));
      follows.set(token, stop);
    },
    logsStop: async (token) => {
      follows.get(token)?.();
      follows.delete(token);
    },
    termOpen: async (id, cols, rows) => {
      const { exec, socket } = await needEngine(() => ops.execTerminal(id, cols, rows));
      const session = `t${++termSeq}`;
      terms.set(session, { socket, exec });
      socket.on('data', (d: Buffer) => send('app:term', { session, data: d.toString('base64') }));
      socket.on('close', () => {
        terms.delete(session);
        send('app:term', { session, data: '', exited: true });
      });
      socket.on('error', () => socket.destroy());
      return session;
    },
    termInput: async (session, data) => {
      terms.get(session)?.socket.write(data);
    },
    termResize: async (session, cols, rows) => {
      const t = terms.get(session);
      if (t) await ops.execResize(t.exec, cols, rows).catch(() => undefined);
    },
    termClose: async (session) => {
      terms.get(session)?.socket.destroy();
      terms.delete(session);
    },
    files: (id, path) => needEngine(() => ops.listFiles(id, path)),
    fileSave: async (id, path) => {
      const r = await dialog.showSaveDialog(win()!, { defaultPath: join(app.getPath('downloads'), `${basename(path) || 'root'}.tar`), filters: [{ name: 'Tar archive', extensions: ['tar'] }] });
      if (r.canceled || !r.filePath) return null;
      await pipeline(await ops.archive(id, path), createWriteStream(r.filePath));
      return r.filePath;
    },
    projects: () => needEngine(() => projects()),
    composePick: async () => {
      const r = await dialog.showOpenDialog(win()!, { title: 'Open a compose file', properties: ['openFile'], filters: [{ name: 'Compose file', extensions: ['yml', 'yaml'] }] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    composeRun: (file, action, token) => runs.compose([file], null, action, token),
    composeProject: async (project, action, token) => {
      const p = (await projects()).find((x) => x.name === project);
      if (!p) throw new Error(`No compose project called ${project}`);
      if (!p.files.length) throw new Error(`${project} was not started from a compose file DoCatz can find`);
      await runs.compose(p.files, project, action, token);
    },
    runCancel: async (token) => runs.cancel(token),
    readText: async (path) => {
      if (statSync(path).size > 2_000_000) throw new Error('That file is too large to edit here');
      return readFileSync(path, 'utf8');
    },
    writeText: async (path, text) => {
      if (!/(^|[\\/])(Dockerfile[^\\/]*|[^\\/]+\.ya?ml|\.dockerignore|\.env[^\\/]*)$/i.test(path)) throw new Error('DoCatz only saves compose files, Dockerfiles and .env files');
      writeFileSync(path, text);
    },

    images: () => needEngine(() => ops.listImages()),
    imageRemove: (id, force) => needEngine(() => ops.imageRemove(id, force)),
    imagePull: (ref, token) => needEngine(() => runs.pull(ref, token)),
    volumes: () => needEngine(() => ops.listVolumes()),
    volumeRemove: (name) => needEngine(() => ops.volumeRemove(name)),
    networks: () => needEngine(() => ops.listNetworks()),
    networkRemove: (id) => needEngine(() => ops.networkRemove(id)),
    prunePreview: (kind) => needEngine(() => ops.prunePreview(kind)),
    prune: (kind) => needEngine(() => ops.prune(kind)),

    envState: async (project, dir) => envState(project, dir),
    envRead: async (project) => envRead(project),
    envWrite: async (project, content, mtime) => envWrite(project, content, mtime),
    envCreate: async (project, dir, from) => envCreate(project, dir, from),
    envLock: async (project, on) => {
      envSetLocked(project, on);
      return envState(project, null);
    },
    envRemove: async (project) => envRemove(project),
    setDomainName: async (key, name) => domains.setName(key, name),

    builds: () => needEngine(() => listBuilds()),
    build: (ref) => needEngine(() => buildDetail(ref)),
    buildLogs: (ref) => needEngine(() => buildLogs(ref)),
    buildRemove: (ref) => needEngine(() => removeBuild(ref)),

    domains: () => domains.refresh(),
    setDomains: (patch) => domains.set(patch),
    caTrust: (on) => domains.trust(on),
    cleanUrls: (on) => domains.cleanUrls(on),
    resolver: (on) => domains.resolver(on),

    appMenu: async (x, y) => appMenuPopup(x, y),
    menuShortcuts: async () => menuShortcuts(),
    menuKey: async (key) => menuKey(key),
  };
}

app.whenReady().then(async () => {
  if (app.isPackaged) app.setAsDefaultProtocolClient('docatz');
  const impl = api() as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const m of API_METHODS) ipcMain.handle(`docatz:${m}`, async (_e, ...args) => impl[m](...args));
  updater.onChange = (s) => {
    send('app:update', s);
    setUpdateLabel(s.status === 'available' || s.status === 'downloaded' ? 'Update Available…' : 'Check for Updates…');
  };
  updater.onOpen = () => {
    openWindow();
    send('app:updateOpen', null);
  };
  reporter.onAsk = () => send('app:reportsAsk', null);
  reporter.start();
  updater.start();
  applySettings((s) => send('app:settings', s));
  void migrateToShared().catch((e) => console.warn('Shared settings migration:', (e as Error).message));
  applyMenu();
  tray.start();
  await domains.start().catch((e) => console.warn('DoCatz proxy:', (e as Error).message));
  const link = process.argv.find((a) => a.startsWith('docatz://'));
  if (link) handleLink(link);
  else openWindow();
  // Found running (DoCatz was quit, the VM was not), or set to start with DoCatz.
  if (await engine.up()) engine.onUp();
  else {
    const s = await engine.state();
    if (s.status === 'stopped' && s.config.autoStart) void engine.start().catch((e) => console.warn('engine autostart:', (e as Error).message));
    else tray.update(s, []);
  }
  // A light poll while nothing else tells us (the VM stopped from outside, stats of the tray).
  setInterval(() => void refresh(), 30_000);
});

