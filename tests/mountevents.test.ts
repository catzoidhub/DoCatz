import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { MountEvents, type OpenMountShell, watchRoots } from '../src/main/engine/mountevents';

const root = mkdtempSync(join(tmpdir(), 'docatz-mounts-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function events() {
  const lines: string[] = [];
  const open: OpenMountShell = () => ({ write: (t) => void lines.push(t), stop: () => undefined });
  return { e: new MountEvents(open, () => [root]), lines };
}

test('only what the VM shares is watched, and no folder twice', () => {
  // Paths with this computer's separator, as the folders DoCatz gets (the test also runs on Windows).
  const p = (s: string) => s.split('/').join(sep);
  expect(watchRoots([p('/home/a/x'), p('/home/a/x/src'), p('/home/a/x'), p('/var/lib/y'), p('/home/a/xy')], [p('/home/a')])).toEqual([p('/home/a/x'), p('/home/a/xy')]);
  expect(watchRoots([p('/home/a')], [p('/home/a')])).toEqual([p('/home/a')]);
});

test('a change passes on the file\'s own time, to the nanosecond', async () => {
  const { e, lines } = events();
  const f = join(root, 'a.txt');
  writeFileSync(f, 'x');
  e.changed(f);
  await wait(30);
  const ns = statSync(f, { bigint: true }).mtimeNs;
  expect(lines.join('')).toBe(`${ns / 1_000_000_000n}.${String(ns % 1_000_000_000n).padStart(9, '0')}\n${f}\n`);
  e.stop();
});

test('setting the same time inside the VM does not come back as a new change, so it cannot loop', async () => {
  const { e, lines } = events();
  const f = join(root, 'b.txt');
  writeFileSync(f, 'x');
  for (let i = 0; i < 5; i++) e.changed(f);
  await wait(30);
  e.changed(f);
  await wait(30);
  expect(lines.length).toBe(1);
  utimesSync(f, new Date(), new Date(Date.now() + 5000));
  e.changed(f);
  await wait(30);
  expect(lines.length).toBe(2);
  e.stop();
});

test('a file that is gone shows as a change of its folder', async () => {
  const { e, lines } = events();
  const dir = join(root, 'd');
  mkdirSync(dir);
  e.changed(join(dir, 'gone.txt'));
  await wait(30);
  expect(lines.join('')).toContain(`\n${dir}\n`);
  e.stop();
});

test('node_modules and .git are left alone', async () => {
  const { e, lines } = events();
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'x.js'), '');
  e.changed(join(root, 'node_modules', 'x.js'));
  e.changed(join(root, '.git', 'HEAD'));
  await wait(30);
  expect(lines).toEqual([]);
  e.stop();
});

test('a path cannot break the line protocol', async () => {
  const { e, lines } = events();
  e.changed(join(root, 'evil\nname'));
  await wait(30);
  expect(lines).toEqual([]);
  e.stop();
});

test('a real change in a watched folder arrives, and stops once the folder is no longer mounted', async () => {
  const { e, lines } = events();
  const dir = join(root, 'watched');
  mkdirSync(dir);
  e.sync([dir]);
  await wait(200);
  writeFileSync(join(dir, 'new.txt'), 'x');
  for (let i = 0; i < 40 && !lines.length; i++) await wait(50);
  expect(lines.join('')).toContain('new.txt');
  e.sync([]);
  const n = lines.length;
  writeFileSync(join(dir, 'later.txt'), 'x');
  await wait(300);
  expect(lines.length).toBe(n);
});
