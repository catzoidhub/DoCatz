import { expect, test } from 'bun:test';
import { MCATZP_COVERAGE } from '../src/main/mcatzp/coverage';
import { changeActions } from '../src/main/mcatzp/changes';
import { destructiveActions } from '../src/main/mcatzp/destructive';
import { allActions } from '../src/main/mcatzp/registry';

const names = new Set(allActions().map((a) => a.name));

test('every tool the coverage file names exists', () => {
  for (const [method, place] of Object.entries(MCATZP_COVERAGE)) {
    const m = /^tool: (.+?)(?: \(|$)/.exec(place);
    if (!m) continue;
    for (const tool of m[1].split(', ')) expect(`${method} → ${names.has(tool) ? tool : `no tool ${tool}`}`).toBe(`${method} → ${tool}`);
  }
});

test('nothing is left for later', () => {
  expect(Object.entries(MCATZP_COVERAGE).filter(([, place]) => !/^(tool: |not a tool|never: )/.test(place))).toEqual([]);
});

test('a destructive tool never offers "allow for this session"', () => {
  for (const a of allActions()) if (a.tier === 'destructive') expect(`${a.name}: ${!!a.allowSession}`).toBe(`${a.name}: false`);
});

// "Allow for this session" holds per tool, whatever the call.
test('what edits a file, shows a secret or runs new code always asks', () => {
  for (const name of ['env_show_secret', 'env_write', 'edit_compose_file', 'compose_up', 'compose_build_up', 'compose_build', 'pull_image', 'migrate_run', 'install_catzoid_app', 'set_domains', 'configure_engine']) expect(`${name}: ${!!allActions().find((a) => a.name === name)?.allowSession}`).toBe(`${name}: false`);
});

test('a client never names a path on this computer', () => {
  for (const a of allActions()) {
    if (a.name === 'list_container_files' || a.name === 'save_container_file') continue; // a path inside the container
    expect(`${a.name}: ${Object.keys((a.input as { properties: object }).properties).filter((p) => /path|folder|dir/.test(p))}`).toBe(`${a.name}: `);
  }
});

test('there is no terminal and no free command', () => {
  for (const a of allActions()) expect(a.name).not.toMatch(/exec|shell|terminal|command/);
});

test('tool names are unique and every input refuses unknown fields', () => {
  const all = allActions();
  expect(new Set(all.map((a) => a.name)).size).toBe(all.length);
  for (const a of all) expect(`${a.name}: ${(a.input as { additionalProperties?: boolean }).additionalProperties}`).toBe(`${a.name}: false`);
});

test('secret values never have a read tool', () => {
  for (const [method, place] of Object.entries(MCATZP_COVERAGE)) if (['setAiKey', 'termOpen', 'termInput', 'runInTerminal'].includes(method)) expect(`${method}: ${place.startsWith('tool:')}`).toBe(`${method}: false`);
});

const noReads = { databasePasswords: () => [], logsTail: async () => [], run: () => null, runs: () => [], tasks: () => ({ migrate: null, sibling: null, file: null }) };
const scopesFor = (changes: boolean) => ({ project: (n: string) => n === 'shared', loose: false, logs: true, resources: true, envValues: true, secretName: () => false, changes, all: false });
const ctx = { client: 't', signal: new AbortController().signal };
const fake = {
  containers: async () => [
    { id: 'aaaaaaaaaaaa', name: 'a', project: 'shared', service: 'a', image: 'x', state: 'running', status: '', ports: [], url: null, domainKey: 'a' },
    { id: 'bbbbbbbbbbbb', name: 'b', project: 'private', service: 'b', image: 'x', state: 'running', status: '', ports: [], url: null, domainKey: 'b' },
    { id: 'cccccccccccc', name: 'gw', project: 'devcatz-gw-ntfy', service: 'gw', image: 'x', state: 'running', status: '', ports: [], url: null, domainKey: 'gw' },
  ],
  projects: async () => [{ name: 'shared', files: ['/x/compose.yml'], dir: '/x', containers: 1, running: 1 }, { name: 'private', files: ['/y/compose.yml'], dir: '/y', containers: 1, running: 1 }],
  containerAction: async () => { throw new Error('must not run'); },
  containerRemove: async () => { throw new Error('must not run'); },
  composeProject: async () => { throw new Error('must not run'); },
} as unknown as import('../src/shared/types').DoCatzApi;

test('a change or a removal outside what is shared is refused, in the question and in the run', async () => {
  const tools = [...changeActions(fake, scopesFor(true), noReads), ...destructiveActions(fake, scopesFor(true), noReads)];
  for (const [name, args] of [['stop_container', { container: 'b' }], ['remove_container', { container: 'b' }], ['compose_up', { project: 'private' }], ['compose_down', { project: 'private' }]] as const) {
    const t = tools.find((x) => x.name === name)!;
    await expect(t.preview(args)).rejects.toThrow(/not shared/);
    await expect(Promise.resolve().then(() => t.run(args, ctx))).rejects.toThrow(/not shared/);
  }
});

test("DevCatz's services stay DevCatz's, even when shared", async () => {
  const all = { ...scopesFor(true), project: () => true };
  const t = changeActions(fake, all, noReads).find((x) => x.name === 'stop_container')!;
  await expect(t.preview({ container: 'gw' })).rejects.toThrow(/DevCatz/);
  await expect(Promise.resolve().then(() => t.run({ container: 'gw' }, ctx))).rejects.toThrow(/DevCatz/);
});

test('changes off: no change or destructive tool is offered at all', () => {
  expect(changeActions(fake, scopesFor(false), noReads)).toEqual([]);
  expect(destructiveActions(fake, scopesFor(false), noReads)).toEqual([]);
});
