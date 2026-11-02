import { execFile, spawn } from 'node:child_process';
import { app, shell } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** The site's platform id for this computer (mac-arm64, mac-x64, win-x64), or null when no Catzoid build exists for it. */
export function platformId(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (process.platform === 'darwin' && arch) return `mac-${arch}`;
  if (isWin && arch === 'x64') return 'win-x64';
  return null;
}

/** "Mac (Apple silicon)", "Mac (Intel)", "Windows" — or this computer's own name when there is no build for it. */
export function platformLabel(): string {
  const id = platformId();
  if (id === 'mac-arm64') return 'Mac (Apple silicon)';
  if (id === 'mac-x64') return 'Mac (Intel)';
  if (id === 'win-x64') return 'Windows';
  return `${process.platform} ${process.arch}`;
}

/** A release asset of `name` for this computer, or null when there is no build for it. */
export function platformAsset(name: string): { pattern: RegExp; label: string } | null {
  const id = platformId();
  if (!id) return null;
  if (id === 'win-x64') return { pattern: new RegExp(`^${name}-Setup-.*\\.exe$`), label: 'Windows' };
  const arch = id === 'mac-arm64' ? 'arm64' : 'x64';
  return { pattern: new RegExp(`^${name}-.*-${arch}\\.dmg$`), label: platformLabel() };
}

/** Where a Catzoid app is installed by default: /Applications on a Mac, the per-user NSIS folder on Windows. */
export function catzoidAppPaths(name: string): string[] {
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
  const handler = await app.getApplicationInfoForProtocol(`${scheme}://open`).catch(() => null);
  if (usable(handler?.path) && new RegExp(name, 'i').test(handler.path)) return handler.path;
  if (isWin) return null;
  const out = await new Promise<string>((resolve) => execFile('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 10_000 }, (_e, stdout) => resolve(String(stdout ?? ''))));
  return out.split('\n').map((l) => l.trim()).find(usable) ?? null;
}

/** Opens a Catzoid app at a link: `open -a` on a Mac (that very copy), the .exe with the link on Windows. */
export async function openCatzoidApp(path: string, link: string): Promise<void> {
  if (isWin) {
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
export const installSteps = (name: string) => ['Find the latest release', 'Download', 'Verify the checksum', 'Install', `Open ${name}`];

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

/**
 * Download & Install of a sibling Catzoid app, as DevCatz installs DoCatz (Windows; the only place DoCatz offers it —
 * DevCatz's gateways): the latest release's installer for this platform (platformAsset), checked against the release's
 * SHA-256 digest, run silently per user (no administrator prompt), then the app opened at `link`.
 */
export async function installCatzoidApp(
  name: string,
  repo: string,
  link: string,
  set: (p: Partial<TaskProgress>) => void,
  signal: AbortSignal,
): Promise<void> {
  const want = platformAsset(name);
  if (!isWin || !want) throw new Error(`Installing ${name} from DoCatz works on Windows; download it from its page instead`);
  set({ step: 0 });
  const asset = await githubAsset(repo, want.pattern);
  if (signal.aborted) throw new Cancelled();
  set({ step: 1, detail: `${asset.name} (${asset.tag})` });
  // fetchPinned checks the SHA-256 as it downloads and never keeps a file that does not match.
  const exe = await fetchPinned({ url: asset.url, sha256: asset.sha256, name: asset.name }, (fraction, got, total) => set({ detail: `${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`, fraction }), signal);
  set({ step: 2, detail: 'SHA-256 matches the release digest', fraction: undefined });
  set({ step: 3, detail: catzoidAppPaths(name)[0] });
  const code = await new Promise<number>((resolve) => execFile(exe, ['/S'], { timeout: 600_000, windowsHide: true }, (e) => resolve(e ? Number((e as NodeJS.ErrnoException).code) || 1 : 0)));
  if (code !== 0) throw new Error(`The ${name} installer stopped (exit ${code})`);
  const path = await findCatzoidApp(name, name.toLowerCase(), '');
  if (!path) throw new Error(`${name} was installed but could not be found`);
  set({ step: 4, detail: '' });
  await openCatzoidApp(path, link);
}
