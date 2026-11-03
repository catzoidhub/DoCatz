import { app, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { binDir } from './paths';
import { isWin } from './platform';
import { createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import { API_METHODS, type DcContainer, type DoCatzApi, type SiblingApp, type TaskProgress } from '@shared/types';
import { AskAi } from './ai';
import { buildDetail, buildLogs, listBuilds, removeBuild } from './builds';
import { composeEnvironmentKeys, envCreate, ownServices, envRead, envRemove, envSetLocked, envState, envWrite, expectedEnv } from './envs';
import { writeBridge } from './bridge';
import { listDatabases, updateDatabases } from './dbservices';
import { migrate, migrateInventory, migrateSources } from './migrate';
import { removeContext, setPath as setCliPath } from './cli';
import { findCatzoidApp, installCatzoidApp, installedVersion, installSteps, openCatzoidApp, platformId, siteAsset } from './companion';
import { DockerError } from './docker/client';
import * as ops from './docker/ops';
import { Domains } from './domains';
import { Engine } from './engine';
import { devcatzGateways } from './gateways';
import { Reporter } from './reporter';
import { run } from './proc';
import { projects, Runs } from './runs';
import { learnProject } from './frameworks';
import { projectPrefs, setProjectPrefs } from './prefs';
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
 *   docatz://gateways?kind=<k> / docatz://services?kind=<k>  (Windows) a DevCatz service in its group
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
    const streams = await updateDatabases(containers).catch((e) => (console.warn('databases:', (e as Error).message), []));
    await domains.setRoutes(containers, streams).catch((e) => console.warn('routes:', (e as Error).message));
    // Frameworks of services built from source (their marks): learnt per project in the background.
    if (containers.some((c) => c.project && !c.framework))
      void projects()
        .then((list) => list.forEach((p) => void learnProject(p.name, p.files, () => void refresh())))
        .catch(() => undefined);
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

/** Engine events that change what the window lists (containers, images, volumes, networks). */
const LIST_EVENTS = new Set([
  ...['create', 'start', 'stop', 'die', 'destroy', 'kill', 'pause', 'unpause', 'restart', 'rename', 'update', 'oom', 'health_status'].map((a) => `container:${a}`),
  ...['pull', 'delete', 'tag', 'untag', 'import', 'load', 'prune'].map((a) => `image:${a}`),
  ...['create', 'destroy', 'prune'].map((a) => `volume:${a}`),
  ...['create', 'destroy', 'connect', 'disconnect', 'prune'].map((a) => `network:${a}`),
]);
let stopEvents: (() => void) | null = null;
let eventTimer: ReturnType<typeof setTimeout> | null = null;
async function watchEvents(): Promise<void> {
  if (stopEvents) return;
  try {
    stopEvents = await ops.watchEvents(
      (type, action) => {
        // Only what changes a list: healthchecks and DoCatz's own reads run `exec` many times a minute.
        if (!LIST_EVENTS.has(`${type}:${action.split(':')[0].trim()}`)) return;
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
    // DevCatz's "Open in DoCatz" for one of its services: docatz://gateways?kind=<kind> (a gateway) or
    // docatz://services?kind=<kind> (Typesense, Sonic, Sockudo, #62) — the DevCatz Services group in Containers; Windows
    // only, as the group — elsewhere the link opens Containers.
    if ((u.hostname === 'gateways' || u.hostname === 'services') && isWin) {
      const kind = u.searchParams.get('kind') ?? u.pathname.replace(/^\//, '');
      if (kind && !/^[a-z0-9-]{1,30}$/.test(kind)) throw new Error('bad service kind');
      return openWindow(kind ? `${u.hostname}/${kind}` : u.hostname);
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

/** Where each sibling's releases are (Download & Install), and the one install that may run at a time. */
const SIBLING_REPO: Record<SiblingApp, string> = { devcatz: 'catzoidhub/DevCatz', dbcatz: 'catzoidhub/DBCatz', dialcatz: 'catzoidhub/DialCatz' };
let siblingTask: TaskProgress | null = null;
let migrateAbort: AbortController | null = null;
let siblingLatest: { at: number; latest: Record<SiblingApp, string | null> } | null = null;
let siblingAbort: AbortController | null = null;

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
      uninstallRun(confirm, shared, async (withShared) => {
        updater.stop();
        reporter.stop();
        for (const t of terms.values()) t.socket.destroy();
        stopEvents?.();
        await engine.reset('reset').catch((e) => console.warn('uninstall: VM not removed:', (e as Error).message));
        removeContext();
        await setCliPath(false).catch(() => undefined);
        await domains.uninstall(withShared);
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
    runInTerminal: async (command) => {
      if (typeof command !== 'string' || command.length > 2000 || /[\u0000-\u0008\n\r]/.test(command)) throw new Error('Not a command DoCatz runs');
      // DoCatz's own docker first on PATH and the docatz context, so a command never lands on another engine.
      if (isWin) {
        const ps = `$env:DOCKER_CONTEXT='docatz'; $env:Path='${binDir().replace(/'/g, "''")};' + $env:Path; ${command}`;
        spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return;
      }
      const sh = `export PATH="${binDir()}:$PATH" DOCKER_CONTEXT=docatz; ${command}`;
      const as = sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await new Promise<void>((resolve, reject) => execFile('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${as}"`, '-e', 'tell application "Terminal" to activate'], (e) => (e ? reject(new Error('Terminal did not open')) : resolve())));
    },
    openSibling: async (which, link) => {
      const info = siblingInfo[which];
      if (!info || !link.startsWith(`${info[1]}://`)) throw new Error('Unknown app or link');
      const path = await findCatzoidApp(...info);
      if (!path) return false;
      await openCatzoidApp(path, link);
      return true;
    },

    migrateSources: () => migrateSources(),
    migrateInventory: (source) => needEngine(() => migrateInventory(source)),
    migrateRun: async (source, images, volumes) => {
      if (migrateAbort) throw new Error('A move is already running');
      migrateAbort = new AbortController();
      const items = [...images.map((i) => `Image ${i}`), ...volumes.map((v) => `Volume ${v}`)];
      let task: TaskProgress = { kind: 'migrate', title: 'Moving to DoCatz', steps: items, step: 0 };
      const set = (p: Partial<TaskProgress>) => send('app:migrate', (task = { ...task, ...p }));
      set({});
      try {
        const failed = await needEngine(() => migrate(source, images, volumes, set, migrateAbort!.signal));
        set({ step: items.length, done: true, error: failed.length ? `${failed.length} could not be moved:\n${failed.join('\n')}` : undefined });
        void refresh();
        return failed;
      } catch (e) {
        const cancelled = migrateAbort.signal.aborted;
        set({ done: true, cancelled, error: cancelled ? 'Cancelled' : (e as Error).message });
        throw e;
      } finally {
        migrateAbort = null;
      }
    },
    migrateCancel: async () => migrateAbort?.abort(),
    siblingVersions: async () => {
      // the site's answer is kept 10 minutes (About opens often; a release does not land that often)
      if (!siblingLatest || Date.now() - siblingLatest.at > 600_000) {
        const latest = await Promise.all((Object.keys(siblingInfo) as SiblingApp[]).map(async (k) => [k, await siteAsset(k, siteBase()).then((a) => a.version).catch(() => null)] as const));
        siblingLatest = { at: Date.now(), latest: Object.fromEntries(latest) as Record<SiblingApp, string | null> };
      }
      const known = siblingLatest.latest;
      const out = await Promise.all(
        (Object.keys(siblingInfo) as SiblingApp[]).map(async (k) => {
          const path = await findCatzoidApp(...siblingInfo[k]).catch(() => null);
          return [k, { installed: path ? await installedVersion(path) : null, latest: known[k] }] as const;
        }),
      );
      return Object.fromEntries(out) as Record<SiblingApp, { installed: string | null; latest: string | null }>;
    },
    devcatzGateways: async () => devcatzGateways(),
    databases: async () => listDatabases().map(({ password: _password, ...d }) => d),
    siblingInstall: async (which, link) => {
      const info = siblingInfo[which];
      if (!info || !link.startsWith(`${info[1]}://`)) throw new Error('Unknown app or link');
      if (siblingTask && !siblingTask.done && !siblingTask.error) return;
      siblingAbort = new AbortController();
      siblingTask = { kind: 'install', title: `Installing ${info[0]}`, steps: installSteps(info[0]), step: 0 };
      const set = (p: Partial<TaskProgress>) => {
        siblingTask = { ...siblingTask!, ...p };
        send('app:siblingTask', siblingTask);
      };
      set({});
      try {
        await installCatzoidApp(info[0], SIBLING_REPO[which], link, set, siblingAbort.signal, siteBase());
        set({ step: siblingTask.steps.length, done: true, detail: '' });
      } catch (e) {
        const cancelled = siblingAbort.signal.aborted;
        set({ error: cancelled ? 'Cancelled' : (e as Error).message, cancelled, done: true });
      } finally {
        siblingAbort = null;
      }
    },
    siblingInstallCancel: async () => siblingAbort?.abort(),

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
    engineSetupWsl: () => engine.setupWsl(),
    restartComputer: async () => {
      const r = await dialog.showMessageBox(win()!, { type: 'question', buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1, message: 'Restart Windows now?', detail: 'Save your work in other apps first. Windows finishes installing WSL while it restarts; open DoCatz again afterwards to start the engine.' });
      if (r.response !== 0) return false;
      await run('shutdown.exe', ['/r', '/t', '5', '/c', 'DoCatz: restarting to finish installing WSL'], { timeout: 15_000 });
      return true;
    },
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

    projectPrefs: async () => projectPrefs(),
    setProjectPrefs: async (p) => setProjectPrefs(p),
    envState: async (project, dir) => envState(project, dir),
    envRead: async (project) => envRead(project),
    envWrite: async (project, content, mtime) => envWrite(project, content, mtime),
    envCreate: async (project, dir, from) => {
      // the stack's own database / cache / mail catcher, so a copied .env points at them rather than at the computer
      const files = (await projects().catch(() => [])).find((p) => p.name === project)?.files ?? [];
      return envCreate(project, dir, from, await ownServices(files, project).catch(() => new Map()));
    },
    envLock: async (project, on) => {
      envSetLocked(project, on);
      return envState(project, null);
    },
    envRemove: async (project) => envRemove(project),
    envDrift: async (project) => {
      const files = (await projects().catch(() => [])).find((p) => p.name === project)?.files ?? [];
      const want = expectedEnv(project, await ownServices(files, project).catch(() => new Map()));
      if (!Object.keys(want).length) return [];
      const list = (await ops.listContainers(domains.urlFor)).filter((c) => c.project === project && c.state === 'running');
      const fixed = await composeEnvironmentKeys(files, project).catch(() => ({}) as Record<string, Set<string>>);
      const out: { container: string; service: string; keys: string[] }[] = [];
      for (const c of list) {
        const have = await ops.containerEnv(c.id).catch(() => null);
        if (!have) continue;
        // A key the compose file sets under environment: is the compose file's to decide, not drift.
        const keys = Object.keys(want).filter((k) => have[k] !== want[k] && !fixed[c.service ?? '']?.has(k));
        if (keys.length) out.push({ container: c.name, service: c.service ?? c.name, keys });
      }
      return out;
    },
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

