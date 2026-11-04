import { type FSWatcher, statSync, watch } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/**
 * File events for the folders running containers mount (DoCatz TODO #8), so hot reload works.
 *
 * A change made on the computer reaches a container through virtiofs at once, but raises no inotify event inside the VM.
 * Lima's mountInotify raises them for the whole home folder and was measured 7 to 16 s late, so DoCatz does it itself: it
 * watches only those folders here and, for each change, sets the file's own modification time again inside the VM. That
 * raises the event there, and leaves the file as it was.
 */

/** One long-lived shell inside the VM, reading a time and a path per change. */
export interface MountShell {
  write(text: string): void;
  stop(): void;
}
export type OpenMountShell = (onExit: () => void) => MountShell;

/** What no dev server watches, and what changes in bursts. */
const SKIP = /(^|[/\\])(node_modules|\.git)([/\\]|$)|\.DS_Store$/;
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** The folders worth a watcher: those the VM shares, without one that another already covers. */
export function watchRoots(folders: string[], shared: string[]): string[] {
  const usable = [...new Set(folders)].filter((f) => shared.some((s) => inside(f, s))).sort((a, b) => a.length - b.length);
  return usable.filter((f, i) => !usable.slice(0, i).some((o) => inside(f, o)));
}

/** The file's time as `touch -d @` takes it, to the nanosecond, so setting it again changes nothing. */
const stamp = (ns: bigint) => `${ns / 1_000_000_000n}.${String(ns % 1_000_000_000n).padStart(9, '0')}`;

export class MountEvents {
  private watchers = new Map<string, FSWatcher>();
  private shell: MountShell | null = null;
  /** The time last passed on per path: setting it inside the VM comes back here as one more event. */
  private seen = new Map<string, bigint>();
  private queue = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private open: OpenMountShell,
    private shared: () => string[],
  ) {}

  /** Watches exactly these folders from now on (the mounts of the running containers). */
  sync(folders: string[]): void {
    const roots = new Set(watchRoots(folders, this.shared()));
    for (const [root, w] of this.watchers) {
      if (roots.has(root)) continue;
      w.close();
      this.watchers.delete(root);
    }
    for (const root of roots) {
      if (this.watchers.has(root)) continue;
      try {
        const isDir = statSync(root).isDirectory();
        const w = watch(root, { recursive: isDir }, (_e, name) => {
          if (name) this.changed(isDir ? join(root, name.toString()) : root);
        });
        w.on('error', () => {
          w.close();
          this.watchers.delete(root);
        });
        this.watchers.set(root, w);
      } catch {
        /* gone since Docker listed it */
      }
    }
    if (!roots.size) this.stop();
  }

  /** A path changed on the computer. A file that is gone shows as a change of its folder. */
  changed(path: string): void {
    if (SKIP.test(path) || path.includes('\n')) return;
    let ns: bigint;
    try {
      ns = statSync(path, { bigint: true }).mtimeNs;
    } catch {
      this.seen.delete(path);
      const parent = dirname(path);
      try {
        ns = statSync(parent, { bigint: true }).mtimeNs;
      } catch {
        return;
      }
      this.seen.set(parent, ns);
      this.send(parent, ns);
      return;
    }
    if (this.seen.get(path) === ns) return;
    if (this.seen.size > 50_000) this.seen.clear();
    this.seen.set(path, ns);
    this.send(path, ns);
  }

  private send(path: string, ns: bigint): void {
    this.queue.set(path, `${stamp(ns)}\n${path}\n`);
    this.timer ??= setTimeout(() => this.flush(), 10);
  }

  private flush(): void {
    this.timer = null;
    const text = [...this.queue.values()].join('');
    this.queue.clear();
    if (!text) return;
    if (!this.shell) {
      const opened: MountShell = this.open(() => {
        if (this.shell === opened) this.shell = null;
      });
      this.shell = opened;
    }
    this.shell.write(text);
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.clear();
    this.seen.clear();
    this.shell?.stop();
    this.shell = null;
  }
}
