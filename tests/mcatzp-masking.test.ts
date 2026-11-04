import { expect, test } from 'bun:test';
import { addEnvSecrets, addSecret, MASK, maskText, secretList } from '../src/main/mcatzp/mask';
import { allActions } from '../src/main/mcatzp/registry';
import { readActions } from '../src/main/mcatzp/actions';
import { follow, progressLine } from '../src/main/mcatzp/changes';
import type { DoCatzApi } from '../src/shared/types';

const secrets = (env: Record<string, string>) => {
  const out = new Set<string>();
  addEnvSecrets(out, env);
  return secretList(out);
};

test('a known value goes wherever it appears: as it is, URL-encoded, in base64', () => {
  const s = secrets({ DB_PASSWORD: 'hunter2 pw!' });
  expect(maskText('connecting with hunter2 pw! now', s)).toBe(`connecting with ${MASK} now`);
  expect(maskText(`q=${encodeURIComponent('hunter2 pw!')}`, s)).toBe(`q=${MASK}`);
  expect(maskText(`Basic-ish ${Buffer.from('hunter2 pw!').toString('base64')} end`, s)).toBe(`Basic-ish ${MASK} end`);
});

test('the password inside an address is known too', () => {
  const s = secrets({ DATABASE_URL: 'postgres://app:s3cretpw@db:5432/app' });
  expect(maskText('auth failed for s3cretpw', s)).toBe(`auth failed for ${MASK}`);
});

test('an ordinary value under an ordinary name stays', () => {
  const s = secrets({ APP_NAME: 'shop', APP_URL: 'https://shop.test', NODE_ENV: 'production' });
  expect(s).toEqual([]);
  expect(maskText('shop started in production at https://shop.test', s)).toBe('shop started in production at https://shop.test');
});

test('what looks like a secret goes by its shape', () => {
  expect(maskText('password=abc123 next', [])).toBe(`password=${MASK} next`);
  expect(maskText('{"token": "abc.def"}', [])).toContain(MASK);
  expect(maskText('redis-server --requirepass meow', [])).toBe(`redis-server --requirepass ${MASK}`);
  expect(maskText('Authorization: Bearer abcdefgh12345', [])).not.toContain('abcdefgh12345');
  expect(maskText('postgres://app:pw12@db/app', [])).toBe(`postgres://app:${MASK}@db/app`);
});

test('too short to tell from text: by name only', () => {
  const out = new Set<string>();
  addSecret(out, 'yes');
  addSecret(out, 'true');
  expect(out.size).toBe(0);
});

/** A log with a secret of a project that is NOT shared, read from a project that is. */
test('container_logs masks secrets of projects not shared, and refuses what is not shared', async () => {
  const c = (name: string, project: string, id: string) => ({ id, name, project, service: name, image: 'x', state: 'running', status: '', health: null, ports: [], url: null, framework: null }) as never;
  const api = {
    containers: async () => [c('a', 'shared', 'aaaaaaaaaaaa'), c('b', 'private', 'bbbbbbbbbbbb')],
    containerEnv: async (id: string) => (id.startsWith('b') ? { API_TOKEN: 'private-token-value' } : { DB_PASSWORD: 'own-password' }),
    envRead: async () => ({ content: 'MAIL_PASSWORD=from-dotenv-file\n', mtime: 0 }),
  } as unknown as DoCatzApi;
  const line = 'x own-password y private-token-value z from-dotenv-file db-pass-value';
  const tools = readActions(api, { project: (n) => n === 'shared', loose: false, logs: true, resources: true, envValues: true, secretName: () => false, changes: false, all: false }, { databasePasswords: () => ['db-pass-value'], logsTail: async () => [{ stream: 'stdout', time: 't', text: line }], run: () => null, runs: () => [], tasks: () => ({ migrate: null, sibling: null }) });
  const logs = tools.find((t) => t.name === 'container_logs')!;
  const ctx = { client: 'test', signal: new AbortController().signal };
  const out = (await logs.run({ container: 'a' }, ctx)).text;
  for (const s of ['own-password', 'private-token-value', 'from-dotenv-file', 'db-pass-value']) expect(out).not.toContain(s);
  await expect(logs.run({ container: 'b' }, ctx) as Promise<unknown>).rejects.toThrow(/not shared/);
});

test('logs off: refused, naming where to turn them on', async () => {
  const tools = readActions({ containers: async () => [] } as unknown as DoCatzApi, { project: () => true, loose: true, logs: false, resources: true, envValues: true, secretName: () => false, changes: false, all: true }, { databasePasswords: () => [], logsTail: async () => [], run: () => null, runs: () => [], tasks: () => ({ migrate: null, sibling: null }) });
  await expect(tools.find((t) => t.name === 'container_logs')!.run({ container: 'a' }, { client: 't', signal: new AbortController().signal }) as Promise<unknown>).rejects.toThrow(/Settings → MCatzP/);
});

test('every tool is a known tier', () => {
  for (const a of allActions()) expect(['read', 'change', 'destructive']).toContain(a.tier);
});

test('the Monitoring tool counts the whole engine but names only what is shared', async () => {
  const c = (id: string, project: string) => ({ id, name: id, project, state: 'running' });
  const stat = (id: string, cpu: number) => ({ id, cpu, memUsed: 100, memLimit: 1000, netRx: 1, netTx: 2, blockRead: 0, blockWrite: 0, pids: 3 });
  const api = {
    engineState: async () => ({ docker: { cpus: 4, memory: 8000 }, config: { cpus: 4 } }),
    containers: async () => [c('web', 'shared'), c('db', 'shared'), c('other', 'private'), { ...c('off', 'shared'), state: 'exited' }],
    stats: async () => [stat('web', 10), stat('db', 30), stat('other', 50)],
  } as unknown as DoCatzApi;
  const reads = { databasePasswords: () => [], logsTail: async () => '', run: () => null, runs: () => [], tasks: () => ({ migrate: null, sibling: null }) };
  const tools = readActions(api, { project: (n) => n === 'shared', loose: false, logs: true, resources: true, envValues: true, secretName: () => false, changes: true, all: false } as never, reads);
  const tool = tools.find((t) => t.name === 'get_monitoring')!;
  const ctx = { client: 'test', signal: new AbortController().signal };
  const out = JSON.parse((await tool.run({}, ctx)).text);
  expect(out.engine).toMatchObject({ running: 3, stopped: 1, cpuPercent: 90, memoryUsed: 300 });
  expect(out.rows.map((r: { name: string }) => r.name)).toEqual(['db', 'web']);
  const grouped = JSON.parse((await tool.run({ by: 'project' }, ctx)).text);
  expect(grouped.rows).toEqual([{ project: 'shared', containers: 2, cpuPercent: 40, memoryUsed: 200, networkIn: 2, networkOut: 4, processes: 6 }]);
});

test('a live progress line is masked, carries no path on this computer, and is cut after that', () => {
  expect(progressLine('login with hunter2pw done', ['hunter2pw'])).toBe(`login with ${MASK} done`);
  expect(progressLine('building /Users/me/shop/Dockerfile now', [])).toBe('building … now');
  expect(progressLine('building C:\\Users\\me\\shop now', [])).toBe('building … now');
  expect(progressLine('Pulling docker.io/library/nginx:1 from https://x.io/a/b', [])).toBe('Pulling docker.io/library/nginx:1 from https://x.io/a/b');
  const long = `${'x'.repeat(198)} hunter2pw`;
  expect(progressLine(long, ['hunter2pw'])).not.toContain('hun');
});

test('follow reports each new line to a client that asks, and stops waiting when the client gives up', async () => {
  const seen: { message: string; percent?: number }[] = [];
  const lines = [{ message: 'one secretvalue1', percent: 10, done: false }, { message: 'one secretvalue1', percent: 10, done: false }, { message: 'two', percent: 50, done: false }, { message: '', done: true }];
  const ctx = { client: 't', signal: new AbortController().signal, progress: (p: { message: string; percent?: number }) => seen.push(p) };
  const r = await follow(ctx as never, () => lines.shift() ?? null, 'still', ['secretvalue1']);
  expect(r.done).toBe(true);
  expect(seen).toEqual([{ message: `one ${MASK}`, percent: 10 }, { message: 'two', percent: 50 }]);
  const stop = new AbortController();
  stop.abort('cancelled');
  expect(await follow({ client: 't', signal: stop.signal, progress: () => undefined } as never, () => null, 'still')).toEqual({ done: false, error: 'still' });
});
