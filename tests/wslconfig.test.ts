import { expect, test } from 'bun:test';
import { iniGet, iniSet } from '../src/main/engine/wslconfig';

test('a key is added to a new or an existing section, the rest untouched', () => {
  expect(iniSet('', 'wsl2', 'guiApplications', 'false')).toBe('[wsl2]\nguiApplications=false\n');
  const own = '[wsl2]\r\nmemory=4GB\r\n# mine\r\n[experimental]\r\nsparseVhd=true\r\n';
  const a = iniSet(iniSet(own, 'wsl2', 'guiApplications', 'false'), 'experimental', 'autoMemoryReclaim', 'dropcache');
  expect(a).toBe('[wsl2]\r\nguiApplications=false\r\nmemory=4GB\r\n# mine\r\n[experimental]\r\nautoMemoryReclaim=dropcache\r\nsparseVhd=true\r\n');
  expect(iniGet(a, 'WSL2', 'guiapplications')).toBe('false');
  expect(iniGet(a, 'wsl2', 'memory')).toBe('4GB');
});

test('an existing value is replaced, whatever its case or spacing', () => {
  expect(iniSet('[Experimental]\n AutoMemoryReclaim = gradual\n', 'experimental', 'autoMemoryReclaim', 'dropcache')).toBe('[Experimental]\nautoMemoryReclaim=dropcache\n');
});

test('removing takes the key, and a section left empty, and nothing else', () => {
  const t = '[wsl2]\nguiApplications=false\nmemory=4GB\n[experimental]\nautoMemoryReclaim=dropcache\n';
  const r = iniSet(iniSet(t, 'wsl2', 'guiApplications', null), 'experimental', 'autoMemoryReclaim', null);
  expect(r).toBe('[wsl2]\nmemory=4GB\n');
  expect(iniSet('[wsl2]\nguiApplications=false\n', 'wsl2', 'guiApplications', null)).toBe('');
  expect(iniSet('[wsl2]\nmemory=4GB\n', 'experimental', 'autoMemoryReclaim', null)).toBe('[wsl2]\nmemory=4GB\n');
});
