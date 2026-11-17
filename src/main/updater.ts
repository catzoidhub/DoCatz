import { app, net, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { autoUpdater, CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { DcReleaseNotes, DcUpdateChannel, DcUpdateSettings, DcUpdateState } from '@shared/types';
import { store } from './store';
import { siteBase } from './shared';
import { platformId } from './companion';

/**
 * In-app updates (Catzoid family TODO #54) with electron-updater. The feed is the Catzoid site's
 * `<shared site address>/updates/docatz/` (it serves latest-mac.yml from the newest GitHub release and redirects the
 * zip there); when the site does not answer, the GitHub release itself. Nothing downloads until the user says
 * Update now; a downloaded update installs on Restart now or when DoCatz quits. Squirrel.Mac checks the Developer ID
 * signature before it swaps the app.
 */

const KEY = 'updates';
const FIRST_CHECK = 30_000;
const EVERY = 6 * 60 * 60_000;

interface Stored extends DcUpdateSettings {
  /** Anonymous install id, sent with update checks (X-Catzoid-Install) for version adoption counts. */
  installId: string;
  /** The version a notification was shown for (once per version). */
  notified: string;
  lastChecked?: number;
}

function stored(): Stored {
  const s = store.extra<Partial<Stored>>(KEY) ?? {};
  const out: Stored = {
    auto: s.auto !== false,
    notify: s.notify !== false,
    channel: s.channel === 'beta' ? 'beta' : 'stable',
    skipped: typeof s.skipped === 'string' ? s.skipped : '',
    dialog: s.dialog !== false,
    promptAt: typeof s.promptAt === 'number' ? s.promptAt : undefined,
    installId: typeof s.installId === 'string' && s.installId ? s.installId : randomUUID(),
    notified: typeof s.notified === 'string' ? s.notified : '',
    lastChecked: typeof s.lastChecked === 'number' ? s.lastChecked : undefined,
  };
  if (out.installId !== s.installId) store.setExtra(KEY, out);
  return out;
}
const save = (patch: Partial<Stored>) => store.setExtra(KEY, { ...stored(), ...patch });
/** The anonymous install id (also on crash / feedback reports). */
export const installId = () => stored().installId;
export const updateChannel = (): DcUpdateChannel => stored().channel;


/** Release notes from the feed (GitHub's release when the site did not answer; the site's latest*.yml has none). */
function notesOf(info: UpdateInfo): DcReleaseNotes[] {
  const n = info.releaseNotes;
  const text = (t: string | null | undefined) => (t ?? '').replace(/<\/(p|li|h\d)>/g, '\n').replace(/<li>/g, '- ').replace(/<[^>]+>/g, '').trim();
  if (!n) return [{ version: info.version, date: info.releaseDate ?? null, notes: '' }];
  if (typeof n === 'string') return [{ version: info.version, date: info.releaseDate ?? null, notes: text(n) }];
  return n.map((v) => ({ version: v.version, date: v.version === info.version ? (info.releaseDate ?? null) : null, notes: text(v.note) }));
}

export class Updater {
  private state: DcUpdateState;
  private token: CancellationToken | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private source: 'site' | 'github' = 'site';
  /** Called on every change (the window shows it; the app menu's item follows). */
  onChange: (s: DcUpdateState) => void = () => undefined;
  /** The notification was clicked: show the What's New dialog. */
  onOpen: () => void = () => undefined;
  /** The window is in front and opens What's New by itself (Catzoid #97): the notification would only repeat it. */
  inFront: () => boolean = () => false;

  constructor() {
    const s = stored();
    this.state = { status: 'idle', current: app.getVersion(), lastChecked: s.lastChecked, settings: this.settings(), downloadUrl: '', notesUrl: '' };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.set({ status: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } }),
    );
    autoUpdater.on('update-downloaded', () => {
      this.set({ status: 'downloaded', progress: undefined });
      this.notify('downloaded');
    });
  }

  private settings(): DcUpdateSettings {
    const { auto, notify, channel, skipped, dialog, promptAt } = stored();
    return { auto, notify, channel, skipped, dialog, promptAt };
  }

  get(): DcUpdateState {
    return {
      ...this.state,
      settings: this.settings(),
      downloadUrl: platformId() ? `${siteBase()}/download/docatz/${platformId()}` : `${siteBase()}/docatz`,
      notesUrl: `${siteBase()}/docatz/download#versions`,
    };
  }

  private set(patch: Partial<DcUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.get());
  }

  /** Automatic checks: 30 s after launch, then every 6 h (when the switch is on). Only a packaged app updates. */
  start(): void {
    if (!app.isPackaged && !process.env.DOCATZ_UPDATE_FEED) return;
    setTimeout(() => void this.auto(), FIRST_CHECK);
    this.timer = setInterval(() => void this.auto(), EVERY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.stopNotes();
  }

  private async auto(): Promise<void> {
    if (!stored().auto || ['checking', 'downloading', 'downloaded'].includes(this.state.status)) return;
    await this.check(false);
  }

  private feed(source: 'site' | 'github', channel: DcUpdateChannel): void {
    const s = stored();
    autoUpdater.allowPrerelease = channel === 'beta';
    autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest';
    // The install id / version / channel go to catzoid.com's feed only, never to GitHub (Catzoid #90): none when the
    // feed is GitHub's release (the fallback when the site does not answer).
    autoUpdater.requestHeaders = source === 'site' ? { 'X-Catzoid-Install': s.installId, 'X-Catzoid-Version': app.getVersion(), 'X-Catzoid-Channel': channel } : null;
    // DOCATZ_UPDATE_FEED: a local feed for tests.
    if (source === 'site') autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DOCATZ_UPDATE_FEED || `${siteBase()}/updates/docatz` });
    else autoUpdater.setFeedURL({ provider: 'github', owner: 'catzoidhub', repo: 'DoCatz' });
    this.source = source;
  }

  /** Asks the site's feed, then the GitHub release when the site does not answer. */
  async check(manual: boolean): Promise<DcUpdateState> {
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.get();
    if (!app.isPackaged && !process.env.DOCATZ_UPDATE_FEED) {
      this.set({ status: 'error', manual, error: 'Updates work in the installed DoCatz only, not in a development build.' });
      return this.get();
    }
    if (process.env.DOCATZ_UPDATE_FEED) autoUpdater.forceDevUpdateConfig = true;
    this.set({ status: 'checking', manual, error: undefined });
    const channel = stored().channel;
    let info: UpdateInfo | null = null;
    let error = '';
    for (const source of process.env.DOCATZ_UPDATE_FEED ? (['site'] as const) : (['site', 'github'] as const)) {
      try {
        this.feed(source, channel);
        const r = await autoUpdater.checkForUpdates();
        info = r?.updateInfo ?? null;
        error = '';
        break;
      } catch (e) {
        error = (e as Error).message.split('\n')[0];
      }
    }
    const lastChecked = Date.now();
    save({ lastChecked });
    // No Windows / Linux build on the feed yet (latest.yml / latest-linux.yml missing, as while the installer waits for
    // signing or before the first Linux release): nothing newer for this copy, not a failure.
    if (error && process.platform !== 'darwin' && /\b404\b/.test(error)) error = '';
    if (error) {
      this.set({ status: 'error', error: `Could not reach the update feed: ${error}`, lastChecked });
      return this.get();
    }
    if (!info || !newer(info.version, app.getVersion())) {
      this.set({ status: 'none', version: undefined, lastChecked });
      return this.get();
    }
    // The file electron-updater will fetch for this computer: Windows the Setup .exe, a Mac the zip of its own chip,
    // Linux the AppImage (or, installed from the .deb, the .deb; electron-updater installs it through pkexec) of its arch.
    const arm = (u: string) => /arm64|aarch64/.test(u);
    const linuxKind = process.env.APPIMAGE ? '.AppImage' : '.deb';
    const mine = (u: string) =>
      process.platform === 'win32' ? u.endsWith('.exe') : process.platform === 'linux' ? u.endsWith(linuxKind) && (process.arch === 'arm64') === arm(u) : u.endsWith('.zip') && (process.arch === 'arm64') === arm(u);
    const size = info.files?.find((f) => mine(f.url))?.size;
    this.set({ status: 'available', version: info.version, notes: await this.notesSince(info), size, releaseDate: info.releaseDate, lastChecked, source: this.source });
    this.lastInfo = info;
    this.retryNotes();
    if (!manual && stored().skipped !== info.version) this.notify('available');
    return this.get();
  }

  /**
   * Release notes of every version after the installed one, from the site's API (`<site>/api/docatz/releases`), else
   * the feed's own (only GitHub's release carries any). "Sometimes no notes" (user, 2026-11-18, all four apps; as
   * DevCatz): the site's feed has no notes, and one slow request or the site's GitHub cache not having the new release
   * yet left What's New empty until the next check 6 h later. Now: three tries, and while the newest version's notes
   * are missing they are fetched again every 5 minutes (an hour at most) and when What's New opens.
   */
  private async notesSince(info: UpdateInfo): Promise<DcReleaseNotes[]> {
    const beta = stored().channel === 'beta';
    const current = app.getVersion();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt * 3000));
      try {
        const res = await net.fetch(`${siteBase()}/api/docatz/releases`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
        const list = (await res.json()) as { version: string; date?: string | null; notes?: string | null }[];
        const out = list.filter((r) => newer(r.version, current) && !newer(r.version, info.version) && (beta || !r.version.includes('-')));
        if (out.some((r) => r.version === info.version && r.notes?.trim())) {
          return out.map((r) => ({ version: r.version, date: r.date ?? null, notes: r.notes ?? '' }));
        }
        break; // answered, but without this release's notes yet: the retries below pick them up
      } catch {
        /* next try */
      }
    }
    return notesOf(info);
  }

  private lastInfo: UpdateInfo | null = null;
  private notesTimer: ReturnType<typeof setInterval> | null = null;
  private notesMissing = () => !!this.state.version && !this.state.notes?.find((n) => n.version === this.state.version)?.notes.trim();

  /** Fetches the notes again while they are missing: every 5 minutes for an hour, and when What's New opens. */
  async refreshNotes(): Promise<void> {
    const info = this.lastInfo;
    if (!info || !this.notesMissing() || !['available', 'downloading', 'downloaded'].includes(this.state.status)) return this.stopNotes();
    const notes = await this.notesSince(info);
    if (info !== this.lastInfo) return;
    if (notes.some((n) => n.notes.trim())) this.set({ notes });
    if (!this.notesMissing()) this.stopNotes();
  }

  private retryNotes(): void {
    this.stopNotes();
    if (!this.notesMissing()) return;
    let left = 12;
    this.notesTimer = setInterval(() => {
      if (--left < 0) return this.stopNotes();
      void this.refreshNotes();
    }, 5 * 60_000);
  }

  private stopNotes(): void {
    if (this.notesTimer) clearInterval(this.notesTimer);
    this.notesTimer = null;
  }

  async download(): Promise<void> {
    if (this.state.status !== 'available' && this.state.status !== 'error') return;
    // The download goes through catzoid.com/updates/docatz/<file>, which redirects to GitHub's release assets, and
    // electron-updater keeps these headers across that redirect: none on the download (Catzoid #90, as DevCatz c3cda70).
    // The next check (feed) sets them again.
    autoUpdater.requestHeaders = null;
    this.token = new CancellationToken();
    this.set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: this.state.size ?? 0, bytesPerSecond: 0 }, error: undefined });
    try {
      await autoUpdater.downloadUpdate(this.token);
    } catch (e) {
      const cancelled = this.token?.cancelled;
      this.set(cancelled ? { status: 'available', progress: undefined } : { status: 'error', progress: undefined, error: `The download failed: ${(e as Error).message.split('\n')[0]}` });
    } finally {
      this.token = null;
    }
  }

  cancel(): void {
    this.token?.cancel();
  }

  skip(version: string): DcUpdateState {
    save({ skipped: version });
    this.set({ status: 'idle' });
    return this.get();
  }

  install(now: boolean): void {
    if (this.state.status !== 'downloaded') return;
    if (now) setImmediate(() => autoUpdater.quitAndInstall(false, true));
    // Otherwise autoInstallOnAppQuit installs it when DoCatz quits.
  }

  configure(patch: Partial<DcUpdateSettings>): DcUpdateState {
    const next: Partial<Stored> = {};
    if (typeof patch.auto === 'boolean') next.auto = patch.auto;
    if (typeof patch.notify === 'boolean') next.notify = patch.notify;
    if (patch.channel === 'stable' || patch.channel === 'beta') next.channel = patch.channel;
    if (typeof patch.dialog === 'boolean') next.dialog = patch.dialog;
    if (typeof patch.promptAt === 'number' && Number.isFinite(patch.promptAt)) next.promptAt = Math.min(patch.promptAt, Date.now());
    save(next);
    this.set({});
    return this.get();
  }

  /** Once per version, only when the switch is on. */
  private notify(kind: 'available' | 'downloaded'): void {
    const s = stored();
    const v = this.state.version ?? '';
    if (!s.notify || !Notification.isSupported() || (s.dialog && this.inFront())) return;
    if (kind === 'available') {
      if (s.notified === v) return;
      save({ notified: v });
    }
    const n = new Notification(
      kind === 'available'
        ? { title: `DoCatz ${v} is available`, body: 'Click to see what’s new.' }
        : { title: 'Ready to install', body: `Restart DoCatz to use ${v}.` },
    );
    n.on('click', () => this.onOpen());
    n.show();
  }
}

/** a > b for x.y.z(-pre) versions. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre = ''] = v.replace(/^v/, '').split('-', 2);
    return { n: main.split('.').map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre > y.pre;
}
