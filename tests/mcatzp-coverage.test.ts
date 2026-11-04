import { expect, test } from 'bun:test';
import { MCATZP_COVERAGE } from '../src/main/mcatzp/coverage';
import { allActions } from '../src/main/mcatzp/registry';

const names = new Set(allActions().map((a) => a.name));

test('every tool the coverage file names exists', () => {
  for (const [method, place] of Object.entries(MCATZP_COVERAGE)) {
    const m = /^tool: (.+?)(?: \(|$)/.exec(place);
    if (!m) continue;
    for (const tool of m[1].split(', ')) expect(`${method} → ${names.has(tool) ? tool : `no tool ${tool}`}`).toBe(`${method} → ${tool}`);
  }
});

test('every method is placed in a known way', () => {
  expect(Object.entries(MCATZP_COVERAGE).filter(([, place]) => !/^(tool: |later: (change|destructive)|not a tool|never: |ask the user)/.test(place))).toEqual([]);
});

test('tool names are unique and every input refuses unknown fields', () => {
  const all = allActions();
  expect(new Set(all.map((a) => a.name)).size).toBe(all.length);
  for (const a of all) expect(`${a.name}: ${(a.input as { additionalProperties?: boolean }).additionalProperties}`).toBe(`${a.name}: false`);
});

test('secret values never have a read tool', () => {
  for (const [method, place] of Object.entries(MCATZP_COVERAGE)) if (['containerEnv', 'envRead', 'setAiKey', 'termOpen', 'termInput'].includes(method)) expect(`${method}: ${place.startsWith('tool:')}`).toBe(`${method}: false`);
});
