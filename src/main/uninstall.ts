import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findCatzoidApp } from './companion';
import type { DcUninstallPlan } from '@shared/types';
import { readShared, setSharedKey, SHARED_DIR } from './shared';
import { isLinux, isWin } from './platform';
import { runAsRootLinux, shq } from './linuxadmin';
import { appImageIconFile } from './appimage';
import type { DcAiProvider } from '@shared/types';
import { words } from '@shared/platform';
import { DOCATZ_HOME } from './paths';

/**
 * Uninstall DoCatz (Catzoid family TODO #55, DoCatz TODO #33; the Homebrew cask's `zap` lists the same paths): first,
 * while DoCatz still runs, the engine's VM and its disk (every container, image and volume in it), the `docatz` docker
 * context, the PATH lines and the :443 forwarding DoCatz installed itself; then, after it quits, ~/.docatz (Lima, the
 * CLIs, downloads), its data folder (settings, bridge.json, certificates), logs, caches, preferences and saved window
 * state — and the app goes to the Trash (or `brew uninstall --cask docatz`). The settings shared with the Catzoid apps
 * (and the shared CA when DoCatz made it) go only when the user switches them on. Project folders that containers
 * mounted are never touched.
 *
 * The removal runs in a small shell script after DoCatz has quit, so nothing writes the files back on the way out.
 * DOCATZ_UNINSTALL_DRY (tests) and unpackaged builds only report the plan.
 *
 * Windows (as DevCatz): the data folder %APPDATA%\DoCatz and electron-updater's %LOCALAPPDATA%\docatz-updater go to the Recycle Bin, the app goes
 * with its own NSIS uninstaller (the app, its shortcuts, its entry in Installed apps), and the docatz:// link goes —
 * all from a small progress window that starts once DoCatz has quit (Windows keeps a running app's profile locked).
 * The shared AI keys are the Catzoid\keys\<provider>.dpapi files.
 *
 * Linux (#101, as DevCatz): ~/.docatz, ~/.config/DoCatz, its caches and menu entry go after it quits; the app is the
 * AppImage (deleted) or the .deb (dpkg -r behind the password prompt, while DoCatz still runs). The engine is the
 * system's Docker Engine, which stays with every container, image and volume in it.
 */

const BUNDLE_ID = 'com.mrcatz.docatz';
const SAFE_STORAGE = 'DoCatz Safe Storage';
const SHARED_KEYS = 'Catzoid AI';
const OTHERS: { name: string; id: string }[] = [
  { name: 'DevCatz', id: 'com.mrcatz.devcatz' },
  { name: 'DBCatz', id: 'com.mrcatz.dbcatz' },
  { name: 'DialCatz', id: 'com.mrcatz.dialcatz' },
];

const home = homedir();
const lib = (...p: string[]) => join(home, 'Library', ...p);
const dryRun = () => !!process.env.DOCATZ_UNINSTALL_DRY || !app.isPackaged;
const run = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((resolve) => execFile(cmd, args, { timeout: 10_000 }, (e, out) => resolve({ ok: !e, out: String(out ?? '') })));

/** The running app bundle (…/DoCatz.app); on Windows the NSIS uninstaller next to DoCatz.exe. */
function bundle(): string | null {
  // Linux: the AppImage file, or a .deb's /opt/DoCatz.
  if (isLinux) return process.env.APPIMAGE || (process.execPath.startsWith('/opt/') ? dirname(process.execPath) : null);
  if (isWin) {
    const u = join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
    return existsSync(u) ? u : null;
  }
  const i = process.execPath.indexOf('.app/');
  return i > 0 ? process.execPath.slice(0, i + 4) : null;
}

async function keychainHas(service: string, account?: string): Promise<boolean> {
  // Windows: the shared AI keys are files (shared.ts).
  if (isWin) return service === SHARED_KEYS && !!account && existsSync(join(SHARED_DIR, 'keys', `${account}.dpapi`));
  // Linux: the shared AI keys are Secret Service items (shared.ts); Electron's own safe storage is not listed there.
  if (isLinux) return service === SHARED_KEYS && !!account && (await run('secret-tool', ['lookup', 'service', service, 'account', account])).ok;
  return (await run('/usr/bin/security', ['find-generic-password', '-s', service, ...(account ? ['-a', account] : [])])).ok;
}

/** Another Catzoid app on this computer (its usual folder, its link handler, or Spotlight — companion.ts). */
async function installed(id: string, name: string): Promise<boolean> {
  return (await findCatzoidApp(name, name.toLowerCase(), id)) !== null;
}

function brew(): string | null {
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync) ?? null;
}
const homebrewInstall = () => ['/opt/homebrew/Caskroom/docatz', '/usr/local/Caskroom/docatz'].some(existsSync);

/** Windows: what DoCatz keeps outside its data folder (electron-updater's downloads). */
function winLeftovers(): { label: string; path: string }[] {
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  return [{ label: 'Update downloads', path: join(local, 'docatz-updater') }].filter((f) => existsSync(f.path));
}

/** Linux: the .deb package this DoCatz came from (null for an AppImage or a copied folder). */
async function linuxPackage(): Promise<string | null> {
  if (!isLinux || process.env.APPIMAGE) return null;
  const r = await run('dpkg', ['-S', process.execPath]);
  return r.ok ? r.out.split(':')[0]?.trim() || null : null;
}

/** Linux: the per-user mimeapps.list files xdg-mime may have written the docatz:// handler to. */
function linuxMimeLists(): string[] {
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const data = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  return [join(config, 'mimeapps.list'), join(data, 'applications', 'mimeapps.list')];
}

/** Linux: what DoCatz keeps outside its data folder (caches, update downloads, the AppImage's menu entry). */
function linuxLeftovers(): { label: string; path: string }[] {
  const cache = process.env.XDG_CACHE_HOME || join(home, '.cache');
  const apps = join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'applications');
  return [
    { label: 'Caches', path: join(cache, 'DoCatz') },
    { label: 'Update downloads', path: join(cache, 'docatz-updater') },
    { label: 'The menu entry', path: join(apps, 'docatz.desktop') },
    { label: 'The menu entry’s icon', path: appImageIconFile() },
  ].filter((f) => existsSync(f.path));
}

export async function uninstallPlan(): Promise<DcUninstallPlan> {
  if (isLinux) {
    const items = [
      { label: 'docker, compose and buildx, downloads (~/.docatz) — the system’s Docker Engine and everything in it stay', path: DOCATZ_HOME },
      { label: 'The docatz docker context and the PATH lines in .bashrc / .zshrc', path: '~/.docker/contexts' },
      { label: 'Settings, certificates, bridge.json', path: app.getPath('userData') },
      ...linuxLeftovers(),
    ].filter((f) => f.path !== DOCATZ_HOME || existsSync(f.path));
    const b = bundle();
    const pkg = await linuxPackage();
    if (b && app.isPackaged) items.push({ label: pkg ? `The app (the ${pkg} package, removed with your password)` : 'The app', path: b });
    const shared: { label: string; path: string }[] = [];
    if (existsSync(join(SHARED_DIR, 'shared.json'))) shared.push({ label: 'Theme, AI provider, site address and domains shared by the Catzoid apps', path: join(SHARED_DIR, 'shared.json') });
    for (const p of readShared().ai?.keys ?? []) if (await keychainHas(SHARED_KEYS, p)) shared.push({ label: `${p} API key (${words.secretStore})`, path: `Keyring: ${SHARED_KEYS} · ${p}` });
    const otherApps: string[] = [];
    for (const o of OTHERS) if (await installed(o.id, o.name)) otherApps.push(o.name);
    return { items, shared, otherApps, homebrew: false, dryRun: dryRun() };
  }
  if (isWin) {
    const items = [{ label: 'The engine: the WSL distro and its disk — every container, image and volume in it', path: join(DOCATZ_HOME, 'vm') }, { label: 'docker, compose and buildx, downloads (~/.docatz)', path: DOCATZ_HOME }, { label: 'The docatz docker context and the PATH entry', path: '~/.docker/contexts' }, { label: 'Settings, certificates, bridge.json', path: app.getPath('userData') }, ...winLeftovers()];
    const u = bundle();
    if (u && app.isPackaged) items.push({ label: 'The app, its shortcuts and its entry in Installed apps (its own uninstaller)', path: u });
    const shared: { label: string; path: string }[] = [];
    if (existsSync(join(SHARED_DIR, 'shared.json'))) shared.push({ label: 'Theme, AI provider, site address and domains shared by the Catzoid apps', path: join(SHARED_DIR, 'shared.json') });
    for (const p of readShared().ai?.keys ?? []) if (await keychainHas(SHARED_KEYS, p)) shared.push({ label: `${p} API key (${words.secretStore})`, path: join(SHARED_DIR, 'keys', `${p}.dpapi`) });
    const otherApps: string[] = [];
    for (const o of OTHERS) if (await installed(o.id, o.name)) otherApps.push(o.name);
    return { items, shared, otherApps, homebrew: false, dryRun: dryRun() };
  }
  const files: { label: string; path: string }[] = [
    { label: 'Settings, certificates, bridge.json', path: app.getPath('userData') },
    { label: 'Logs', path: app.getPath('logs') },
    { label: 'Caches', path: lib('Caches', 'DoCatz') },
    { label: 'Caches', path: lib('Caches', BUNDLE_ID) },
    { label: 'Update downloads', path: lib('Caches', `${BUNDLE_ID}.ShipIt`) },
    { label: 'Update downloads', path: lib('Caches', 'docatz-updater') },
    { label: 'Preferences', path: lib('Preferences', `${BUNDLE_ID}.plist`) },
    { label: 'Saved window state', path: lib('Saved Application State', `${BUNDLE_ID}.savedState`) },
    { label: 'Web storage', path: lib('HTTPStorages', BUNDLE_ID) },
  ].filter((f) => existsSync(f.path));
  const items = [
    { label: 'The engine: the Linux VM and its disk — every container, image and volume in it', path: join(DOCATZ_HOME, 'vm') },
    { label: 'Lima, docker, compose and buildx, downloads', path: DOCATZ_HOME },
    { label: 'The docatz docker context and the PATH lines in .zprofile / .bash_profile', path: '~/.docker/contexts' },
    ...files,
  ].filter((f) => f.path !== DOCATZ_HOME || existsSync(f.path));
  if (await keychainHas(SAFE_STORAGE)) items.push({ label: `Stored secrets (${words.secretStore})`, path: `Keychain: ${SAFE_STORAGE}` });
  const b = bundle();
  const homebrew = homebrewInstall();
  if (b && app.isPackaged) items.push({ label: homebrew ? 'The app (brew uninstall --cask docatz)' : 'The app (moved to the Trash)', path: b });

  const shared: { label: string; path: string }[] = [];
  if (existsSync(join(SHARED_DIR, 'shared.json'))) shared.push({ label: 'Theme, AI provider, site address and domains shared by the Catzoid apps', path: join(SHARED_DIR, 'shared.json') });
  for (const p of readShared().ai?.keys ?? []) if (await keychainHas(SHARED_KEYS, p)) shared.push({ label: `${p} API key (${words.secretStore})`, path: `Keychain: ${SHARED_KEYS} · ${p}` });

  const otherApps: string[] = [];
  for (const o of OTHERS) if (await installed(o.id, o.name)) otherApps.push(o.name);
  return { items, shared, otherApps, homebrew, dryRun: dryRun() };
}

/** The shared CA is DoCatz's to remove: DoCatz made it and no other app is listed as using the domains. */
const ownCa = () => readShared().domains?.ca?.by === 'docatz' && !(readShared().domains?.usedBy ?? []).some((a) => a !== 'docatz');

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Removes DoCatz after it quits. `shared`: the shared Catzoid settings too. `beforeQuit` deletes the VM, the context and the PATH lines. */
export async function uninstallRun(confirm: string, shared: boolean, beforeQuit: (withShared: boolean) => Promise<void>): Promise<DcUninstallPlan> {
  if (confirm.trim() !== 'DoCatz') throw new Error('Type DoCatz to confirm');
  const plan = await uninstallPlan();
  const withShared = shared;
  if (plan.dryRun) return { ...plan, shared: withShared ? plan.shared : [] };

  await beforeQuit(withShared);
  if (isWin) {
    // The shared settings as on macOS: shared.json, the AI keys, and the CA only when DoCatz made it and no other app
    // uses it — never the whole Catzoid folder, which the other apps keep their own things in.
    const sharedPaths: string[] = [];
    if (withShared) {
      for (const p of readShared().ai?.keys ?? []) await setSharedKey(p as DcAiProvider, '').catch(() => undefined);
      sharedPaths.push(join(SHARED_DIR, 'shared.json'));
      if (ownCa()) sharedPaths.push(join(SHARED_DIR, 'ca'));
    }
    const folders = [app.getPath('userData'), DOCATZ_HOME, ...winLeftovers().map((f) => f.path), ...sharedPaths];
    await afterQuitWin(bundle(), folders);
    setImmediate(() => app.exit(0));
    return plan;
  }
  if (isLinux) {
    if (withShared) for (const p of readShared().ai?.keys ?? []) await setSharedKey(p as DcAiProvider, '').catch(() => undefined);
    // The .deb's files are root's: dpkg removes them (and the menu entry) behind the password prompt; a running program
    // keeps its open files, so DoCatz still finishes and quits.
    const pkg = await linuxPackage();
    if (pkg) {
      const r = await runAsRootLinux(`dpkg -r ${shq(pkg)} >/dev/null`);
      if (!r.ok) console.warn('uninstall: dpkg -r:', r.message);
    }
    const out = ['#!/bin/sh', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`];
    for (const f of plan.items) if (!f.path.startsWith('~') && !f.path.startsWith('/opt/')) out.push(`rm -rf ${q(f.path)}`);
    if (withShared) {
      out.push(`rm -f ${q(join(SHARED_DIR, 'shared.json'))}`);
      if (ownCa()) out.push(`rm -rf ${q(join(SHARED_DIR, 'ca'))}`);
      out.push(`rmdir ${q(SHARED_DIR)} 2>/dev/null`);
    }
    // The docatz:// handler xdg-mime wrote when the menu entry was made (appimage.ts) stays in mimeapps.list otherwise,
    // pointing at a .desktop file that is gone (found in the x64 VM, 2026-11-10). Only that line goes.
    for (const f of linuxMimeLists()) out.push(`[ -f ${q(f)} ] && sed -i '/^x-scheme-handler\\/docatz=docatz\\.desktop;\\?$/d' ${q(f)}`);
    out.push('rm -f "$0"');
    const script = join(tmpdir(), `docatz-uninstall-${process.pid}.sh`);
    writeFileSync(script, out.join('\n') + '\n', { mode: 0o700 });
    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', cwd: dirname(script) }).unref();
    setImmediate(() => app.exit(0));
    return plan;
  }
  const lines = ['#!/bin/sh', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`];
  for (const f of plan.items) {
    if (f.path.startsWith('Keychain: ')) lines.push(`/usr/bin/security delete-generic-password -s ${q(SAFE_STORAGE)} >/dev/null 2>&1`);
    else if (!f.path.endsWith('.app') && !f.path.startsWith('~')) lines.push(`rm -rf ${q(f.path)}`);
  }
  if (withShared) {
    lines.push(`rm -f ${q(join(SHARED_DIR, 'shared.json'))}`);
    if (ownCa()) lines.push(`rm -rf ${q(join(SHARED_DIR, 'ca'))}`);
    lines.push(`rmdir ${q(SHARED_DIR)} 2>/dev/null`);
    for (const p of readShared().ai?.keys ?? []) lines.push(`/usr/bin/security delete-generic-password -s ${q(SHARED_KEYS)} -a ${q(p)} >/dev/null 2>&1`);
  }
  const b = bundle();
  const brewBin = brew();
  if (plan.homebrew && brewBin) lines.push(`${q(brewBin)} uninstall --cask docatz >/dev/null 2>&1`);
  else if (b) lines.push(`mv ${q(b)} ${q(join(home, '.Trash', `DoCatz ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.app`))}`);
  lines.push('rm -f "$0"');
  const script = join(tmpdir(), `docatz-uninstall-${process.pid}.sh`);
  writeFileSync(script, lines.join('\n') + '\n', { mode: 0o700 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', cwd: dirname(script) }).unref();
  setImmediate(() => app.exit(0));
  return plan;
}

/**
 * Windows: a detached PowerShell (DevCatz's helper) that finishes once DoCatz has quit, in a small window of its own so
 * the user sees it happen: waits for DoCatz to close, runs the NSIS uninstaller silently, removes the docatz:// link,
 * moves the folders to the Recycle Bin, says it is done and removes itself. Started by Task Scheduler as a task of
 * this user, not as DoCatz's child (a child went with DoCatz when it quit).
 */
async function afterQuitWin(uninstaller: string | null, folders: string[]): Promise<void> {
  const pq = (x: string) => `'${x.replace(/'/g, "''")}'`;
  const task = `DoCatz uninstall ${Date.now()}`;
  const script = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$exe = ${pq(process.execPath)}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
Add-Type -Namespace Win -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Win.Dpi]::SetProcessDPIAware() | Out-Null
[Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object Windows.Forms.Form
$f.Text = 'Uninstalling DoCatz'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.ClientSize = New-Object Drawing.Size(460, 254); $f.Font = New-Object Drawing.Font('Segoe UI', 9.5); $f.TopMost = $true
$f.Icon = [Drawing.Icon]::ExtractAssociatedIcon($exe)
$title = New-Object Windows.Forms.Label; $title.Text = 'Removing DoCatz from this PC'; $title.Font = New-Object Drawing.Font('Segoe UI Semibold', 11)
$title.SetBounds(20, 16, 420, 26); $f.Controls.Add($title)
$names = @('Waiting for DoCatz to close', 'Removing the app, its shortcuts and its entry in Installed apps', 'Moving its data and settings to the Recycle Bin')
$rows = @(); $y = 52
foreach ($n in $names) { $l = New-Object Windows.Forms.Label; $l.Text = "○  $n"; $l.ForeColor = [Drawing.Color]::Gray; $l.SetBounds(20, $y, 420, 22); $f.Controls.Add($l); $rows += $l; $y += 26 }
$bar = New-Object Windows.Forms.ProgressBar; $bar.SetBounds(20, 136, 420, 14); $bar.Maximum = $names.Count; $f.Controls.Add($bar)
$note = New-Object Windows.Forms.Label; $note.Text = 'Project folders your containers used are not touched.'; $note.ForeColor = [Drawing.Color]::Gray; $note.SetBounds(20, 160, 420, 40); $f.Controls.Add($note)
$ok = New-Object Windows.Forms.Button; $ok.Text = 'Close'; $ok.SetBounds(350, 208, 90, 30); $ok.Enabled = $false; $ok.Add_Click({ $f.Close() }); $f.Controls.Add($ok)
$f.Show(); [Windows.Forms.Application]::DoEvents()
function Step($i) { if ($i -gt 0) { $rows[$i - 1].Text = '✓  ' + $names[$i - 1]; $rows[$i - 1].ForeColor = [Drawing.Color]::FromArgb(22, 128, 61) }; if ($i -lt $rows.Count) { $rows[$i].Text = '●  ' + $names[$i]; $rows[$i].ForeColor = [Drawing.SystemColors]::ControlText }; $bar.Value = $i; [Windows.Forms.Application]::DoEvents() }
function Wait($cond) { for ($i = 0; $i -lt 240 -and (& $cond); $i++) { Start-Sleep -Milliseconds 250; [Windows.Forms.Application]::DoEvents() } }
Step 0; Wait { Get-Process | Where-Object { $_.Path -eq $exe } }
Step 1
${uninstaller ? `$u = Start-Process -FilePath ${pq(uninstaller)} -ArgumentList '/S' -PassThru; Wait { -not $u.HasExited }
# The uninstaller hands over to a copy of itself in the temp folder and returns at once: wait for the app to go.
Wait { Test-Path $exe }` : ''}
# The docatz:// link Electron registered for this user (the uninstaller leaves it), when it still points here.
$link = 'HKCU:\Software\Classes\docatz'; if ((Get-ItemProperty "$link\shell\open\command").'(default)' -like "*$exe*") { Remove-Item -Recurse -Force $link }
Step 2
foreach ($p in @(${folders.map(pq).join(', ')})) { if (Test-Path $p) { try { if (Test-Path $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } } catch { Remove-Item -Recurse -Force $p } }; [Windows.Forms.Application]::DoEvents() }
Step 3
$title.Text = 'DoCatz has been removed'
$note.Text = 'Project folders your containers used are not touched. Its data is in the Recycle Bin until you empty it.'
$ok.Enabled = $true; $ok.Focus() | Out-Null
Remove-Item -Force $MyInvocation.MyCommand.Path
schtasks.exe /delete /tn ${pq(task)} /f | Out-Null
$t = New-Object Windows.Forms.Timer; $t.Interval = 30000; $t.Add_Tick({ $f.Close() }); $t.Start()
while ($f.Visible) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
`;
  const file = join(tmpdir(), `docatz-uninstall-${Date.now()}.ps1`);
  // UTF-8 with a byte-order mark: Windows PowerShell 5 reads a file without one as the ANSI code page (✓ ● ○).
  writeFileSync(file, `\ufeff${script.replace(/\r?\n/g, '\r\n')}`);
  const ps = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${file}"`;
  const made = await runCode('schtasks.exe', ['/create', '/tn', task, '/tr', ps, '/sc', 'once', '/st', '00:00', '/it', '/f']);
  if (made === 0 && (await runCode('schtasks.exe', ['/run', '/tn', task])) === 0) return;
  console.warn('uninstall: schtasks failed, starting the helper directly');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
const runCode = (cmd: string, args: string[]) =>
  new Promise<number>((resolve) => execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (e) => resolve(e ? Number((e as NodeJS.ErrnoException).code) || 1 : 0)));

