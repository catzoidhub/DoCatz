import { expect, test } from 'bun:test';
import { addEnvSecrets, addSecret, MASK, maskText, secretList } from '../src/main/mcatzp/mask';
import { allActions } from '../src/main/mcatzp/registry';
import { readActions } from '../src/main/mcatzp/actions';
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
  const tools = readActions(api, { project: (n) => n === 'shared', loose: false, logs: true, resources: true, envValues: true, secretName: () => false, changes: false, all: false }, { databasePasswords: () => ['db-pass-value'], logsTail: async () => [{ stream: 'stdout', time: 't', text: line }], run: () => null, runs: () => [] });
  const logs = tools.find((t) => t.name === 'container_logs')!;
  const ctx = { client: 'test', signal: new AbortController().signal };
  const out = (await logs.run({ container: 'a' }, ctx)).text;
  for (const s of ['own-password', 'private-token-value', 'from-dotenv-file', 'db-pass-value']) expect(out).not.toContain(s);
  await expect(logs.run({ container: 'b' }, ctx) as Promise<unknown>).rejects.toThrow(/not shared/);
});

test('logs off: refused, naming where to turn them on', async () => {
  const tools = readActions({ containers: async () => [] } as unknown as DoCatzApi, { project: () => true, loose: true, logs: false, resources: true, envValues: true, secretName: () => false, changes: false, all: true }, { databasePasswords: () => [], logsTail: async () => [], run: () => null, runs: () => [] });
  await expect(tools.find((t) => t.name === 'container_logs')!.run({ container: 'a' }, { client: 't', signal: new AbortController().signal }) as Promise<unknown>).rejects.toThrow(/Settings → MCatzP/);
});

test('every tool is a known tier', () => {
  for (const a of allActions()) expect(['read', 'change', 'destructive']).toContain(a.tier);
});
