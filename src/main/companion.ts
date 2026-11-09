import { execFile, spawn } from 'node:child_process';
import { app, net, shell } from 'electron';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskProgress } from '@shared/types';
import { Cancelled, fetchPinned } from './download';

/**
 * Which build of a Catzoid app fits this computer, and where a sibling app lives (Catzoid family rule, user
 * 2026-10-27; the same shape as DevCatz's src/main/companion.ts): every install, update or link picks the build by
 * platform AND architecture — Windows `<App>-Setup-<v>.exe`, Mac Apple silicon `<App>-<v>-arm64.dmg`, Mac Intel
 * `<App>-<v>-x64.dmg`, site links `<site>/download/<app>/<platform>` — and says so when there is none, never another
 * platform's file.
 */

const isWin = process.platform === 'win32';
/** Linux (#101): AppImages in ~/Applications or a .deb's /opt/<App>, as DevCatz's companion.ts. */
const isLinux = process.platform === 'linux';

/** The site's platform id for this computer (mac-arm64, mac-x64, win-x64), or null when no Catzoid build exists for it. */
export function platformId(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (process.platform === 'darwin' && arch) return `mac-${arch}`;
  if (isWin && arch === 'x64') return 'win-x64';
  if (isLinux && arch) return `linux-${arch}`;
  return null;
}

/** "Mac (Apple silicon)", "Mac (Intel)", "Windows" — or this computer's own name when there is no build for it. */
export function platformLabel(): string {
  const id = platformId();
  if (id === 'mac-arm64') return 'Mac (Apple silicon)';
  if (id === 'mac-x64') return 'Mac (Intel)';
  if (id === 'win-x64') return 'Windows';
  if (id === 'linux-arm64') return 'Linux (ARM64)';
  if (id === 'linux-x64') return 'Linux (x64)';
  return `${process.platform} ${process.arch}`;
}

/** A release asset of `name` for this computer, or null when there is no build for it. */
export function platformAsset(name: string): { pattern: RegExp; label: string } | null {
  const id = platformId();
  if (!id) return null;
  if (id === 'win-x64') return { pattern: new RegExp(`^${name}-Setup-.*\\.exe$`), label: 'Windows' };
  if (id.startsWith('linux-')) return { pattern: new RegExp(`^${name}-.*-${id.slice(6)}\\.AppImage$`), label: platformLabel() };
  const arch = id === 'mac-arm64' ? 'arm64' : 'x64';
  return { pattern: new RegExp(`^${name}-.*-${arch}\\.dmg$`), label: platformLabel() };
}

/**
 * Where a Catzoid app is installed by default: /Applications on a Mac, the per-user NSIS folder on Windows; on Linux
 * the AppImage in ~/Applications (where the apps install themselves and each other), or a .deb's /opt/<App>.
 */
export function catzoidAppPaths(name: string): string[] {
  if (isLinux) return [join(homedir(), 'Applications', `${name}.AppImage`), `/opt/${name}/${name.toLowerCase()}`, `/opt/${name}/${name}`];
  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return [join(local, 'Programs', name, `${name}.exe`), join(process.env.ProgramFiles ?? 'C:\\Program Files', name, `${name}.exe`)];
  }
  return [`/Applications/${name}.app`, join(homedir(), 'Applications', `${name}.app`)];
}

/**
 * Finds a Catzoid app: the usual folders, the app that opens its links (`scheme://`), then (macOS) Spotlight by
 * bundle id. Null when it is not installed.
 */
export async function findCatzoidApp(name: string, scheme: string, bundleId: string): Promise<string | null> {
  const usable = (p: string | null | undefined): p is string =>
    !!p && (isWin ? /\.exe$/i.test(p) && existsSync(p) : !p.includes('/.Trash/') && existsSync(join(p, 'Contents', 'Info.plist')));
  const known = catzoidAppPaths(name).find((p) => existsSync(p));
  if (known) return known;
  if (isLinux) return null;
  const handler = await app.getApplicationInfoForProtocol(`${scheme}://open`).catch(() => null);
  if (usable(handler?.path) && new RegExp(name, 'i').test(handler.path)) return handler.path;
  if (isWin) return null;
  const out = await new Promise<string>((resolve) => execFile('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 10_000 }, (_e, stdout) => resolve(String(stdout ?? ''))));
  return out.split('\n').map((l) => l.trim()).find(usable) ?? null;
}

/** Opens a Catzoid app at a link: `open -a` on a Mac (that very copy), the .exe with the link on Windows. */
export async function openCatzoidApp(path: string, link: string): Promise<void> {
  if (isWin || isLinux) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(path, [link], { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => (child.unref(), resolve(true)));
    });
    if (!ok) await shell.openExternal(link);
    return;
  }
  const ok = await new Promise<boolean>((resolve) => execFile('open', ['-a', path, link], { timeout: 30_000 }, (e) => resolve(!e)));
  if (!ok) await shell.openExternal(link);
}

/** The steps a sibling's Download & Install shows (the same as DevCatz's for DoCatz). */
export const installSteps = (name: string) => ['Find the latest release', 'Download', 'Verify the checksum', isWin ? 'Install' : isLinux ? 'Install to ~/Applications' : 'Install to Applications', `Open ${name}`];

/** The newest release's file matching `match`, with its SHA-256 from GitHub's release digest. */
async function githubAsset(repo: string, match: RegExp): Promise<{ url: string; sha256: string; tag: string; name: string }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}${res.status === 403 ? ' (too many requests: try again later)' : ''}`);
  const releases = (await res.json()) as { tag_name: string; prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; digest?: string }[] }[];
  for (const r of releases) {
    if (r.prerelease || r.draft) continue;
    const a = r.assets.find((x) => match.test(x.name));
    if (a?.digest?.startsWith('sha256:')) return { url: a.browser_download_url, sha256: a.digest.slice(7), tag: r.tag_name, name: a.name };
  }
  throw new Error(`There is no ${platformLabel()} build of it with a checksum in ${repo}'s releases yet`);
}

/** The newest build of `app` for this computer, as the Catzoid site lists it (#60). */
export interface SiteAsset {
  version: string;
  name: string;
  size: number;
  sha256: string;
  url: string;
}

/** Thrown when the site has no build of the app for this computer: never fall back to another platform's file. */
export class NoBuild extends Error {}

/**
 * The site's newest build of `app` for this computer: `<site>/api/<app>/latest?platform=<mac-arm64|mac-x64|win-x64>`
 * (Catzoid family #78, DoCatz TODO #60). A 404 is "no build for this computer yet" (NoBuild); anything else that goes
 * wrong (offline, the site down) throws a plain Error, so callers can fall back to GitHub.
 */
export async function siteAsset(app: string, site: string, signal?: AbortSignal): Promise<SiteAsset> {
  const platform = platformId();
  if (!platform) throw new NoBuild(`There is no ${app} build for ${platformLabel()}`);
  const res = await net.fetch(`${site}/api/${app}/latest?platform=${platform}`, { signal, headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new NoBuild(`There is no ${app} build for ${platformLabel()} yet (${site}/download/${app}/${platform})`);
  if (!res.ok) throw new Error(`${new URL(site).host} answered ${res.status}`);
  const a = (await res.json()) as Partial<SiteAsset>;
  const fits = platform === 'win-x64' ? /\.exe$/i : platform.startsWith('linux-') ? new RegExp(`-${platform.slice(6)}\\.AppImage$`, 'i') : platform === 'mac-arm64' ? /-arm64\.dmg$/i : /-x64\.dmg$/i;
  if (typeof a.version !== 'string' || typeof a.name !== 'string' || typeof a.url !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256 ?? '') || !/^https:\/\//.test(a.url)) throw new Error('The site gave an unusable answer');
  // the file must be this computer's (an .exe on Windows, the arm64 / x64 DMG on a Mac), whatever the site says
  if (!fits.test(a.name)) throw new Error(`The site offered ${a.name}, which is not a ${platformLabel()} build`);
  return { version: a.version, name: a.name, size: Number(a.size) || 0, sha256: a.sha256!, url: a.url };
}

/** The version of an installed Catzoid app at `path` (its bundle on a Mac, its .exe on Windows), or null. */
export async function installedVersion(path: string): Promise<string | null> {
  // Linux: a .deb's version from dpkg (its package is the app's name in lower case); an AppImage does not say.
  if (isLinux) {
    const pkg = /^\/opt\/([^/]+)\//.exec(path)?.[1]?.toLowerCase();
    if (!pkg) return null;
    const r = await run('dpkg-query', ['-W', '-f=${Version}', pkg], 10_000);
    return r.code === 0 ? (/\d+\.\d+\.\d+/.exec(r.out)?.[0] ?? null) : null;
  }
  const out = await new Promise<string>((resolve) =>
    isWin
      ? execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${path.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { timeout: 15_000, windowsHide: true }, (_e, o) => resolve(String(o ?? '')))
      : execFile('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(path, 'Contents', 'Info.plist')], { timeout: 10_000 }, (_e, o) => resolve(String(o ?? ''))),
  );
  const v = /\d+\.\d+\.\d+/.exec(out)?.[0];
  return v ?? null;
}

/** a.b.c newer than x.y.z. */
export const newer = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

const run = (cmd: string, args: string[], timeout: number) =>
  new Promise<{ code: number; out: string }>((resolve) => execFile(cmd, args, { timeout, windowsHide: true }, (e, stdout, stderr) => resolve({ code: e ? Number((e as NodeJS.ErrnoException).code) || 1 : 0, out: String(stderr || stdout || '') })));

/**
 * Download & Install of a sibling Catzoid app, as DevCatz installs DoCatz: the build for this computer from the
 * Catzoid site (#60; GitHub's newest release when the site cannot be reached, never when it says there is no build),
 * its SHA-256 checked while it downloads, then on Windows the installer run silently per user (no administrator
 * prompt), on a Mac the app copied from the DMG to Applications — and the app opened at `link`.
 */
export async function installCatzoidApp(
  name: string,
  repo: string,
  link: string,
  set: (p: Partial<TaskProgress>) => void,
  signal: AbortSignal,
  site: string,
): Promise<void> {
  const want = platformAsset(name);
  if (!want) throw new NoBuild(`There is no ${name} build for ${platformLabel()}`);
  set({ step: 0 });
  let asset: { url: string; sha256: string; name: string; tag: string };
  try {
    const a = await siteAsset(name.toLowerCase(), site, signal);
    asset = { url: a.url, sha256: a.sha256, name: a.name, tag: a.version };
  } catch (e) {
    if (signal.aborted) throw new Cancelled();
    // Linux: until the site lists Linux builds, GitHub's release is where they are.
    if (e instanceof NoBuild && !isLinux) throw e;
    console.warn(`${name} from the site: ${(e as Error).message}; trying GitHub`);
    asset = await githubAsset(repo, want.pattern);
  }
  if (signal.aborted) throw new Cancelled();
  set({ step: 1, detail: `${asset.name} (${asset.tag.replace(/^v/, '')})` });
  // fetchPinned checks the SHA-256 as it downloads and never keeps a file that does not match.
  const file = await fetchPinned({ url: asset.url, sha256: asset.sha256, name: asset.name }, (fraction, got, total) => set({ detail: `${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`, fraction }), signal);
  set({ step: 2, detail: 'SHA-256 matches', fraction: undefined });
  if (isWin) {
    set({ step: 3, detail: catzoidAppPaths(name)[0] });
    const r = await run(file, ['/S'], 600_000);
    if (r.code !== 0) throw new Error(`The ${name} installer stopped (exit ${r.code})`);
    const path = await findCatzoidApp(name, name.toLowerCase(), '');
    if (!path) throw new Error(`${name} was installed but could not be found`);
    set({ step: 4, detail: '' });
    await openCatzoidApp(path, link);
    return;
  }
  if (isLinux) {
    // The AppImage into ~/Applications (no administrator needed), a menu entry that also opens its links, then the app.
    const target = catzoidAppPaths(name)[0];
    set({ step: 3, detail: target });
    mkdirSync(join(target, '..'), { recursive: true });
    rmSync(`${target}.new`, { force: true });
    copyFileSync(file, `${target}.new`);
    chmodSync(`${target}.new`, 0o755);
    renameSync(`${target}.new`, target);
    writeDesktopEntry(name, target);
    set({ step: 4, detail: '' });
    await openCatzoidApp(target, link);
    return;
  }
  const target = `/Applications/${name}.app`;
  set({ step: 3, detail: target });
  const mountDir = mkdtempSync(join(tmpdir(), `${name.toLowerCase()}-`));
  let mounted = false;
  try {
    const att = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountDir, file], 120_000);
    if (att.code !== 0) throw new Error(`The disk image could not be opened: ${att.out.trim()}`);
    mounted = true;
    if (!existsSync(join(mountDir, `${name}.app`))) throw new Error(`${name}.app was not found in the disk image`);
    if (signal.aborted) throw new Cancelled();
    rmSync(target, { recursive: true, force: true });
    const cp = await run('ditto', [join(mountDir, `${name}.app`), target], 300_000);
    if (cp.code !== 0) throw new Error(`Copying to Applications failed: ${cp.out.trim()}`);
    // downloaded from the internet: clear the quarantine mark so Gatekeeper does not hold up the first launch
    await run('xattr', ['-dr', 'com.apple.quarantine', target], 60_000);
  } finally {
    if (mounted) await run('hdiutil', ['detach', mountDir, '-quiet'], 60_000);
    rmSync(mountDir, { recursive: true, force: true });
  }
  set({ step: 4, detail: '' });
  await openCatzoidApp(target, link);
}

/** Linux: a menu entry for an AppImage, registered for the app's `scheme://` links (xdg-mime), as DevCatz writes it. */
function writeDesktopEntry(name: string, exe: string): void {
  const scheme = name.toLowerCase();
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
  mkdirSync(dir, { recursive: true });
  const id = `${scheme}.desktop`;
  writeFileSync(
    join(dir, id),
    ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec="${exe}" %U`, `Icon=${scheme}`, 'Terminal=false', 'Categories=Development;', `MimeType=x-scheme-handler/${scheme};`, ''].join('\n'),
  );
  void run('xdg-mime', ['default', id, `x-scheme-handler/${scheme}`], 10_000);
  void run('update-desktop-database', [dir], 10_000);
}
