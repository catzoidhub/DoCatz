import { spawn } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import { chmodSync, copyFileSync, openSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './proc';
import { isLinux } from './platform';

/**
 * Linux, the AppImage (#101, Catzoid #93 — user, 2026-11-09: "installer di linux harus estetik sama seperti dmg dan
 * exe"; the same window as the sibling app's, in DoCatz's colours): an AppImage is
 * one file that runs from wherever it was downloaded, with no menu entry and no `docatz://` links. On its first run
 * from outside ~/Applications, DoCatz opens a small window in the DMG's look (the same gradient, dots, wordmark and
 * logo) that offers to install it: the file moves to ~/Applications/DoCatz.AppImage, a menu entry with the icon and
 * the docatz:// handler is written (XDG), and DoCatz restarts from there. "Just run it" remembers the choice for that
 * file; a newer AppImage run later offers to replace the installed one.
 */

const appsDir = () => join(homedir(), 'Applications');
export const installedAppImage = () => join(appsDir(), 'DoCatz.AppImage');
const dataHome = () => process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
export const appImageDesktopFile = () => join(dataHome(), 'applications', 'docatz.desktop');
export const appImageIconFile = () => join(dataHome(), 'icons', 'hicolor', '512x512', 'apps', 'docatz.png');
const choiceFile = () => join(app.getPath('userData'), 'appimage-run-in-place.json');

function runInPlaceChosen(file: string): boolean {
  try {
    return (JSON.parse(readFileSync(choiceFile(), 'utf8')) as { files?: string[] }).files?.includes(file) ?? false;
  } catch {
    return false;
  }
}
function rememberRunInPlace(file: string): void {
  let files: string[] = [];
  try {
    files = (JSON.parse(readFileSync(choiceFile(), 'utf8')) as { files?: string[] }).files ?? [];
  } catch {
    /* first time */
  }
  mkdirSync(dirname(choiceFile()), { recursive: true });
  writeFileSync(choiceFile(), JSON.stringify({ files: [...new Set([...files, file])].slice(-10) }));
}

/** The menu entry, the icon and the docatz:// handler for an AppImage at `exe`. */
export async function writeAppImageEntry(exe: string, resources: string): Promise<void> {
  const icon = appImageIconFile();
  mkdirSync(dirname(icon), { recursive: true });
  const src = [join(resources, 'icon.png'), join(resources, 'icon-192.png')].find((f) => existsSync(f));
  if (src) copyFileSync(src, icon);
  const desktop = appImageDesktopFile();
  mkdirSync(dirname(desktop), { recursive: true });
  writeFileSync(
    desktop,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=DoCatz',
      'GenericName=Docker desktop',
      'Comment=Containers, compose projects, images and builds on your Docker engine',
      `Exec="${exe}" %U`,
      'Icon=docatz',
      'Terminal=false',
      'StartupWMClass=docatz',
      'Categories=Development;',
      'Keywords=docker;compose;containers;images;dev;',
      'MimeType=x-scheme-handler/docatz;',
      '',
    ].join('\n'),
  );
  await run('xdg-mime', ['default', 'docatz.desktop', 'x-scheme-handler/docatz'], { timeout: 10_000 }).catch(() => undefined);
  await run('update-desktop-database', [dirname(desktop)], { timeout: 10_000 }).catch(() => undefined);
  await run('gtk-update-icon-cache', ['-q', '-t', join(dataHome(), 'icons', 'hicolor')], { timeout: 10_000 }).catch(() => undefined);
}

function page(icon: string, replacing: boolean): string {
  const logo = existsSync(icon) ? `data:image/png;base64,${readFileSync(icon).toString('base64')}` : '';
  // DoCatz's DMG (scripts/dmg/background.svg): the sky-blue gradient, teal and light glows, the dots, ink #2f2878.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Install DoCatz</title><style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%;overflow:hidden;font-family:Inter,'Cantarell','Ubuntu',system-ui,sans-serif;color:#2f2878;-webkit-user-select:none;cursor:default}
  body{background:
    radial-gradient(60% 60% at 12% 100%,rgba(60,200,180,.22),rgba(60,200,180,0)),
    radial-gradient(50% 50% at 95% 2%,rgba(230,246,255,.5),rgba(230,246,255,0)),
    linear-gradient(135deg,#86cbf8 0%,#5eb3f0 55%,#4499e2 100%)}
  body:before{content:'';position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.16) .9px,transparent 1px);background-size:16px 16px;
    -webkit-mask-image:linear-gradient(#000 0%,rgba(0,0,0,.15) 75%,transparent);pointer-events:none}
  .drag{position:absolute;inset:0 0 auto 0;height:40px;-webkit-app-region:drag}
  .close{position:absolute;top:10px;right:12px;width:26px;height:26px;border-radius:13px;border:0;background:rgba(47,40,120,.12);color:#2f2878;font-size:15px;line-height:26px;cursor:pointer;-webkit-app-region:no-drag}
  .close:hover{background:rgba(47,40,120,.22)}
  main{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;padding-top:34px}
  h1{font-size:24px;font-weight:700;letter-spacing:-.4px}
  .sub{margin-top:6px;font-size:13px;font-weight:500;opacity:.78}
  .stage{margin-top:14px;width:160px;height:160px;border-radius:50%;display:grid;place-items:center;
    background:radial-gradient(circle,rgba(255,255,255,.32) 0%,rgba(255,255,255,.08) 60%,rgba(255,255,255,0) 100%)}
  .stage img{width:104px;height:104px;filter:drop-shadow(0 8px 18px rgba(20,60,120,.3))}
  .actions{margin-top:14px;display:flex;flex-direction:column;align-items:center;gap:9px}
  button.primary{border:0;border-radius:10px;padding:10px 26px;font:600 14px inherit;font-family:inherit;color:#fff;background:#2f2878;cursor:pointer;box-shadow:0 6px 18px rgba(20,40,110,.28)}
  button.primary:hover{background:#3b3391}
  button.primary:disabled{opacity:.7;cursor:progress}
  a{font-size:12px;color:#2f2878;opacity:.7;text-decoration:none;cursor:pointer}
  a:hover{opacity:1;text-decoration:underline}
  .where{margin-top:10px;font-size:10.5px;opacity:.55;font-family:ui-monospace,'DejaVu Sans Mono',monospace}
  footer{position:absolute;bottom:14px;left:0;right:0;text-align:center;font-size:11px;font-weight:500;opacity:.6}
  .dot{display:inline-block;width:6px;height:6px;border-radius:3px;background:#ffc14d;box-shadow:0 0 0 4px rgba(255,193,77,.35);margin-right:8px;vertical-align:middle}
  </style></head><body><div class="drag"></div><button class="close" title="Quit" onclick="location.href='docatz-install:quit'">×</button>
  <main>
    <h1>DoCatz</h1>
    <div class="sub">${replacing ? 'Replace the DoCatz in your Applications with this one' : 'Install DoCatz into your Applications'}</div>
    <div class="stage">${logo ? `<img src="${logo}" alt="">` : ''}</div>
    <div class="actions">
      <button class="primary" id="go" onclick="this.disabled=true;this.textContent='Installing…';location.href='docatz-install:install'">${replacing ? 'Replace and open' : 'Install DoCatz'}</button>
      <a onclick="location.href='docatz-install:run'">Just run it from here</a>
    </div>
    <div class="where">~/Applications/DoCatz.AppImage · menu entry · docatz:// links</div>
  </main>
  <footer><span class="dot"></span>Containers, compose projects and a domain for each — in one window</footer>
  </body></html>`;
}

/**
 * Called once at start. Returns true when DoCatz is restarting from ~/Applications (or quitting): the caller stops.
 */
export async function offerAppImageInstall(resources: string): Promise<boolean> {
  const file = process.env.APPIMAGE;
  if (!isLinux || !file || !app.isPackaged) return false;
  const target = installedAppImage();
  if (file === target) {
    // Installed: keep the menu entry pointing here (it may be gone, or from an older layout).
    if (!existsSync(appImageDesktopFile())) await writeAppImageEntry(target, resources).catch(() => undefined);
    return false;
  }
  if (runInPlaceChosen(file)) return false;

  const choice = await new Promise<'install' | 'run' | 'quit'>((resolve) => {
    const win = new BrowserWindow({
      width: 600,
      height: 400,
      resizable: false,
      maximizable: false,
      frame: false,
      center: true,
      show: false,
      backgroundColor: '#5eb3f0',
      title: 'Install DoCatz',
      icon: join(resources, 'icon.png'),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let done = false;
    const finish = (c: 'install' | 'run' | 'quit') => {
      if (done) return;
      done = true;
      resolve(c);
      if (c !== 'install') win.destroy();
    };
    win.webContents.on('will-navigate', (e, url) => {
      e.preventDefault();
      const m = url.match(/^docatz-install:(install|run|quit)$/);
      if (m) finish(m[1] as 'install' | 'run' | 'quit');
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => finish('quit'));
    win.once('ready-to-show', () => win.show());
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(join(resources, 'icon.png'), existsSync(target)))}`);
    app.once('before-quit', () => finish('quit'));
    // Kept until the install finishes, then closed by the relaunch.
    (offerAppImageInstall as { win?: BrowserWindow }).win = win;
  });

  if (choice === 'quit') {
    app.exit(0);
    return true;
  }
  if (choice === 'run') {
    rememberRunInPlace(file);
    return false;
  }
  try {
    mkdirSync(appsDir(), { recursive: true });
    if (existsSync(target)) unlinkSync(target);
    try {
      renameSync(file, target);
    } catch {
      // Another filesystem (a USB stick, a mounted share): copy, then remove the download when it lets us.
      copyFileSync(file, target);
      rmSync(file, { force: true });
    }
    chmodSync(target, 0o755);
    await writeAppImageEntry(target, resources);
    // Its own session: the old AppImage's runtime ends its children when it unmounts (app.relaunch's child died with it).
    // A clean environment: the old runtime's APPDIR / APPIMAGE / ARGV0 and paths into its mount (gone once it exits)
    // would make the new one look for its files there.
    const mount = process.env.APPDIR ?? '\u0000';
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'CHROME_DESKTOP', 'GDK_BACKEND'].includes(k)) continue;
      env[k] = v.includes(mount) ? v.split(':').filter((x) => !x.startsWith(mount)).join(':') : v;
    }
    mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true });
    const log = openSync(join(app.getPath('userData'), 'logs', 'appimage-relaunch.log'), 'a');
    // Started once this instance is gone: it still holds the single-instance lock, so the new one would quit at once.
    // Every inherited descriptor above stderr is closed first: one into the old AppImage's mount (app.asar) kept that
    // mount alive until the new DoCatz quit.
    // bash: dash (Ubuntu's /bin/sh) reads `exec 10>&-` as running a command named 10, and the relaunch never happened.
    const args = process.argv.slice(1).filter((x) => !x.startsWith('--appimage') && x !== '--no-sandbox');
    // Without bash, only single-digit descriptors are closed (as DevCatz 9a82f28).
    const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const close = shell === '/bin/bash' ? 'for fd in $(ls /proc/$$/fd); do [ "$fd" -gt 2 ] && eval "exec $fd>&-"; done' : 'for fd in 3 4 5 6 7 8 9; do eval "exec $fd>&-"; done';
    spawn(shell, ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; ${close} 2>/dev/null; exec "$0" "$@"`, target, ...args], { detached: true, stdio: ['ignore', log, log], env, cwd: homedir() }).unref();
    app.exit(0);
    return true;
  } catch (e) {
    console.error('AppImage install:', e);
    (offerAppImageInstall as { win?: BrowserWindow }).win?.destroy();
    rememberRunInPlace(file);
    return false;
  }
}
