import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// frameworks.ts reaches Electron through its neighbours; detection itself only reads files.
mock.module('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0', isPackaged: false }, net: {}, shell: {}, dialog: {}, BrowserWindow: class {}, ipcMain: {}, nativeTheme: {}, crashReporter: {}, clipboard: {} }));
const { detectBuild, detectFramework } = await import('../src/main/frameworks');
const { apiSource } = await import('../src/main/apisource');
const { frameworkTag } = await import('../src/renderer/src/frameworks');

const root = mkdtempSync(join(tmpdir(), 'docatz-fw-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const project = (files: Record<string, string>) => {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
};
const GOMOD = 'module x\n\ngo 1.22\n';

describe('Go', () => {
  test('Goravel wins over the Gin it requires itself', () => {
    expect(detectFramework(project({ 'go.mod': `${GOMOD}require (\n  github.com/gin-gonic/gin v1.10.0\n  github.com/goravel/framework v1.15.0\n)\n` }))).toEqual({ framework: 'go', library: 'goravel' });
  });
  test('Gin alone stays Gin', () => {
    expect(detectFramework(project({ 'go.mod': `${GOMOD}require github.com/gin-gonic/gin v1.10.0\n` }))).toEqual({ framework: 'go', library: 'gin' });
  });
  test('a go.mod with no known library is plain Go, wherever main.go lives', () => {
    expect(detectFramework(project({ 'go.mod': GOMOD, 'cmd/server/main.go': 'package main' }))).toEqual({ framework: 'go', library: null });
  });
  test('a lone main.go counts when it serves something', () => {
    expect(detectFramework(project({ 'main.go': 'package main\nimport "net/http"\n' }))).toEqual({ framework: 'go', library: null });
    expect(detectFramework(project({ 'main.go': 'package main\nimport "fmt"\n' }))).toBeNull();
  });
});

describe('Rust', () => {
  test('a crate with no known library is plain Rust', () => {
    expect(detectFramework(project({ 'Cargo.toml': '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\n' }))).toEqual({ framework: 'rust', library: null });
  });
  test('a known library is named', () => {
    expect(detectFramework(project({ 'Cargo.toml': '[package]\nname = "x"\n\n[dependencies]\naxum = "0.7"\n' }))).toEqual({ framework: 'rust', library: 'axum' });
  });
});

describe('JavaScript', () => {
  test('a package.json with no framework is plain Node', () => {
    expect(detectFramework(project({ 'package.json': '{"name":"x"}', 'server.js': '' }))).toEqual({ framework: 'node', library: null });
  });
  test('a lone file that listens is plain Node', () => {
    expect(detectFramework(project({ 'server.js': "require('node:http').createServer(f).listen(3000)" }))).toEqual({ framework: 'node', library: null });
    expect(detectFramework(project({ 'index.mjs': "import { createServer } from 'node:http'; createServer(f);" }))).toEqual({ framework: 'node', library: null });
  });
  test('Bun.serve and Deno.serve name their runtime', () => {
    expect(detectFramework(project({ 'index.ts': 'Bun.serve({ fetch })' }))).toEqual({ framework: 'node', library: 'bun' });
    expect(detectFramework(project({ 'main.ts': 'Deno.serve(handler)' }))).toEqual({ framework: 'node', library: 'deno' });
  });
  test('a script that serves nothing is not a project', () => {
    expect(detectFramework(project({ 'index.js': "console.log('hi')" }))).toBeNull();
  });
});

describe('Python', () => {
  test('a lone script on the standard library is plain Python', () => {
    expect(detectFramework(project({ 'main.py': 'from http.server import HTTPServer' }))).toEqual({ framework: 'python', library: null });
    expect(detectFramework(project({ 'app.py': 'import http.server' }))).toEqual({ framework: 'python', library: null });
  });
  test('a pyproject with no framework is plain Python, one with a framework is that', () => {
    expect(detectFramework(project({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = []\n' }))).toEqual({ framework: 'python', library: null });
    expect(detectFramework(project({ 'requirements.txt': 'fastapi==0.110\n' }))).toEqual({ framework: 'fastapi', library: null });
  });
  test('a script that serves nothing is not a project', () => {
    expect(detectFramework(project({ 'main.py': "print('hi')" }))).toBeNull();
  });
});

describe('the rest', () => {
  test('an index.html alone is a static site; nothing at all is nothing', () => {
    expect(detectFramework(project({ 'index.html': '<h1>x</h1>' }))).toEqual({ framework: 'static', library: null });
    expect(detectFramework(project({ 'README.md': 'x' }))).toBeNull();
  });
  test('a real framework wins over a file that only looks plain', () => {
    expect(detectFramework(project({ 'package.json': '{"dependencies":{"next":"15"}}', 'server.js': 'http.createServer(f).listen(1)', 'index.html': '' }))?.framework).toBe('next');
    expect(detectFramework(project({ 'composer.json': '{"require":{"laravel/framework":"11"}}', artisan: '', 'main.py': 'import http.server' }))?.framework).toBe('laravel');
  });
  test("in a monorepo a stray index.html does not hide the framework above it", () => {
    const dir = project({ 'package.json': '{"dependencies":{"next":"15"}}', 'docker/Dockerfile': 'FROM x', 'docker/index.html': '' });
    expect(detectBuild(dir, 'docker/Dockerfile')?.framework).toBe('next');
  });
});

describe('what the app shows', () => {
  const label = (framework: string, library: string | null = null) => frameworkTag(framework, library).label;
  test('each has its own name, the same as DevCatz', () => {
    expect(label('go', 'goravel')).toBe('Goravel');
    expect(label('go')).toBe('Go');
    expect(label('rust')).toBe('Rust');
    expect(label('python')).toBe('Python');
    expect(label('node', 'bun')).toBe('Bun');
    expect(label('node', 'deno')).toBe('Deno');
    expect(label('static')).toBe('HTML');
  });
  test('Goravel has its own mark', () => {
    expect(frameworkTag('go', 'goravel').icon.title).toBe('Goravel');
    expect(frameworkTag('static').icon.title).toBe('HTML5');
  });
  test('Goravel offers its route list; a plain project no API source unless it carries a document', () => {
    const go = project({ 'go.mod': `${GOMOD}require github.com/goravel/framework v1.15.0\n` });
    expect(apiSource(go, ['go', 'goravel'])?.how).toBe('goravel');
    expect(apiSource(project({ 'go.mod': GOMOD }), ['go'])).toBeNull();
    const doc = project({ 'go.mod': GOMOD, 'openapi.yaml': 'openapi: 3.0.0\n' });
    expect(apiSource(doc, ['go'])).not.toBeNull();
  });
});
