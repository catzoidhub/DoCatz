import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DcWslMemory } from '@shared/types';

/**
 * Windows: "Use less memory for WSL" (TODO #106) — two WSL-wide settings in %USERPROFILE%\.wslconfig, written only when
 * the user says so (they hold for every WSL distro on the PC):
 *   [wsl2] guiApplications=false                 no WSLg (the system distro that shows Linux GUI apps)
 *   [experimental] autoMemoryReclaim=dropcache   memory Linux no longer uses goes back to Windows
 * Measured on the Windows PC with 5 small containers (2026-11-18): 1422 MB by default, 980 MB without WSLg, 655 MB
 * with both after a few minutes (`gradual` held more: ~1.49 GB). Everything else in the file stays as it is; turning
 * it off removes only these two lines, and only while they hold DoCatz's values.
 */

const FILE = () => join(homedir(), '.wslconfig');
const KEYS: [section: string, key: string, value: string][] = [
  ['wsl2', 'guiApplications', 'false'],
  ['experimental', 'autoMemoryReclaim', 'dropcache'],
];

const read = (): string => {
  try {
    return existsSync(FILE()) ? readFileSync(FILE(), 'utf8').replace(/^﻿/, '') : '';
  } catch {
    return '';
  }
};

/** The lines of `section` as [first, end) indexes (end = the next section or the file's end); null without one. */
function sectionOf(lines: string[], section: string): [number, number] | null {
  const at = lines.findIndex((l) => l.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && /^\s*\[.*\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  return [at + 1, end];
}
const keyAt = (lines: string[], range: [number, number], key: string): number => {
  for (let i = range[0]; i < range[1]; i++) if (new RegExp(`^\\s*${key}\\s*=`, 'i').test(lines[i])) return i;
  return -1;
};

/** The value of `key` in `section` ('' when missing). Exported for tests. */
export function iniGet(text: string, section: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const range = sectionOf(lines, section);
  const i = range ? keyAt(lines, range, key) : -1;
  return i < 0 ? '' : lines[i].slice(lines[i].indexOf('=') + 1).trim();
}

/** `key` set to `value` in `section` (made when missing), or removed with null; the rest untouched. Exported for tests. */
export function iniSet(text: string, section: string, key: string, value: string | null): string {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const range = sectionOf(lines, section);
  const i = range ? keyAt(lines, range, key) : -1;
  if (value === null) {
    if (i >= 0) lines.splice(i, 1);
    // A section left with nothing in it goes too.
    const r = sectionOf(lines, section);
    if (r && lines.slice(r[0], r[1]).every((l) => !l.trim())) lines.splice(r[0] - 1, r[1] - r[0] + 1);
  } else if (i >= 0) lines[i] = `${key}=${value}`;
  else if (range) lines.splice(range[0], 0, `${key}=${value}`);
  else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(`[${section}]`, `${key}=${value}`);
  }
  const out = lines.join(eol).replace(/(\r?\n)+$/, '');
  return out ? out + eol : '';
}

export function wslMemory(): DcWslMemory {
  const text = read();
  const gui = iniGet(text, 'wsl2', 'guiApplications').toLowerCase();
  const reclaim = iniGet(text, 'experimental', 'autoMemoryReclaim').toLowerCase();
  return { file: FILE(), on: gui === 'false' && reclaim === 'dropcache', gui: gui !== 'false', reclaim: reclaim || 'disabled' };
}

/** Writes (or takes back) the two settings; the caller restarts WSL for them to hold. */
export function setWslMemory(on: boolean): DcWslMemory {
  let text = read();
  for (const [section, key, value] of KEYS) {
    if (on) text = iniSet(text, section, key, value);
    else if (iniGet(text, section, key).toLowerCase() === value) text = iniSet(text, section, key, null);
  }
  const tmp = `${FILE()}.docatz.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, FILE());
  return wslMemory();
}
