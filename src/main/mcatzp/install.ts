import { approvalsAcrossApps, type McatzpApproval, type McatzpUninstall, uninstall as hostUninstall, addToClient as add, install as run, type McatzpInstallProgress, type McatzpSetup, type McatzpTarget, removeFromClient as remove, setupState as state, targets as list, type McatzpTargetId, type SetupOptions } from '@catzoid/mcatzp-host';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { siteBase } from '../shared';

/** An app opened from the desktop has a bare PATH on a Mac; Homebrew's or npm's copy is only found with the login shell's. */
let shellEnv: Promise<NodeJS.ProcessEnv> | null = null;
function loginEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return Promise.resolve(process.env);
  shellEnv ??= new Promise((done) => {
    const marker = '__DOCATZ_ENV__';
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', `echo ${marker}; env; echo ${marker}`], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (_e, out) => {
      const body = String(out ?? '').split(marker)[1] ?? '';
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const line of body.split('\n')) {
        const at = line.indexOf('=');
        if (at > 0 && line.slice(0, at) === 'PATH') env.PATH = line.slice(at + 1);
      }
      done(env);
    });
  });
  return shellEnv;
}

/** The shared copy of MCatzP and the assistants' entries: the rules live in the shared package, for every Catzoid app. */
const options = async (): Promise<SetupOptions> => ({ site: siteBase(), env: await loginEnv() });

export const setupState = async (askSite = true): Promise<McatzpSetup> => state(await options(), askSite);
/** The version to update to: only a copy these apps installed, a Homebrew or npm copy updates its own way. Null when up to date. */
export async function availableUpdate(): Promise<string | null> {
  const { source, version, latest } = await setupState();
  return source === 'catzoid' && version && latest && version.localeCompare(latest, undefined, { numeric: true }) < 0 ? latest : null;
}
export const install = async (progress: (p: McatzpInstallProgress) => void, signal: AbortSignal): Promise<void> => run(await options(), progress, signal);
/** Where each client is approved, from every Catzoid app's bridge.json. Approvals stay per app: this only reads them. */
export const approvals = async (): Promise<McatzpApproval[]> => approvalsAcrossApps(await options());
export const targets = async (): Promise<McatzpTarget[]> => list(await options());
export const addToClient = async (id: McatzpTargetId): Promise<void> => add(await options(), id);
export const removeFromClient = async (id: McatzpTargetId): Promise<void> => remove(await options(), id);

/**
 * Uninstall MCatzP (user, 2026-11-10; the same in every Catzoid app): the host's own uninstall (mcatzp-host 1.0.3) —
 * the entries that run the copy in use leave their clients, the shared copy and an emptied bin folder go, a Homebrew /
 * npm copy stays (its path is returned), an `npx` entry is left alone. Clients it could not change are in `failed`.
 */
export async function uninstall(): Promise<McatzpUninstall> {
  const r = await hostUninstall(await options());
  // The host removes the emptied bin folder but not the one above it (~/.catzoid, %LOCALAPPDATA%\Catzoid; found in the
  // x64 VM, 2026-11-10): it goes too when nothing else is in it — rmdir only, never anything with files inside.
  if (r.binary === 'removed') {
    const dir = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Catzoid') : join(homedir(), '.catzoid');
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      /* not empty or not ours to remove: it stays */
    }
  }
  return r;
}
