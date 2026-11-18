import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DoCatz's settings: one JSON file in the app's data folder, written
 * atomically. Secrets inside are safeStorage-encrypted by their owners.
 * Two processes share it (the app and the engine helper, #107): a read picks up the other's writes (the file's mtime
 * changed) and a write reads the file first, so neither puts back keys the other has just changed.
 */

export function dataDir(...parts: string[]): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(dir, ...parts);
  if (parts.length && !existsSync(out) && !/\.[a-z0-9]+$/i.test(parts[parts.length - 1])) mkdirSync(out, { recursive: true });
  return out;
}

interface Data {
  extra?: Record<string, unknown>;
}

class Store {
  private data: Data = {};
  private file: string;
  private mtime = -1;

  constructor() {
    this.file = dataDir('config.json');
    this.load();
  }

  private load(): void {
    let m = 0;
    try {
      m = statSync(this.file).mtimeMs;
    } catch {
      m = 0;
    }
    if (m === this.mtime) return;
    this.mtime = m;
    try {
      this.data = m ? (JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) as Data) : {};
    } catch (e) {
      console.error('config.json could not be read:', e);
    }
  }

  extra<T>(key: string): T | undefined {
    this.load();
    return this.data.extra?.[key] as T | undefined;
  }

  setExtra(key: string, value: unknown): void {
    this.load();
    this.data.extra = { ...(this.data.extra ?? {}), [key]: value };
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
    try {
      this.mtime = statSync(this.file).mtimeMs;
    } catch {
      this.mtime = -1;
    }
  }
}

export const store = new Store();
