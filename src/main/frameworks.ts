import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { DcFramework, DcFrameworkName } from '@shared/types';
import { cliInstalled, composeBin } from './cli';
import { dockerHost } from './paths';
import { run } from './proc';

/**
 * Which framework a compose service is built from, for its mark in the list (the same marks and the same markers as
 * DevCatz's detection: package.json dependencies, composer.json, go.mod, Cargo.toml, Python requirements). The build
 * folder of each service comes from `docker compose config`; a service that only runs an image keeps the image's logo.
 * Cached per project until its compose files change.
 */

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};
const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const GO_LIBS: [RegExp, string][] = [
  [/github\.com\/gin-gonic\/gin\b/, 'gin'],
  [/github\.com\/labstack\/echo\b/, 'echo'],
  [/github\.com\/gofiber\/fiber\b/, 'fiber'],
  [/github\.com\/go-chi\/chi\b/, 'chi'],
  [/github\.com\/gorilla\/mux\b/, 'gorilla'],
  [/github\.com\/beego\/beego\b/, 'beego'],
  [/github\.com\/kataras\/iris\b/, 'iris'],
  [/github\.com\/gobuffalo\/buffalo\b/, 'buffalo'],
  [/github\.com\/cloudwego\/hertz\b/, 'hertz'],
  [/github\.com\/go-kratos\/kratos\b/, 'kratos'],
  [/github\.com\/zeromicro\/go-zero\b/, 'go-zero'],
  [/gofr\.dev\b/, 'gofr'],
  [/github\.com\/julienschmidt\/httprouter\b/, 'httprouter'],
];
const RUST_LIBS: [string, string][] = [
  ['actix-web', 'actix'], ['axum', 'axum'], ['rocket', 'rocket'], ['warp', 'warp'], ['poem', 'poem'], ['salvo', 'salvo'], ['loco-rs', 'loco'],
  ['leptos', 'leptos'], ['yew', 'yew'], ['dioxus', 'dioxus'], ['sycamore', 'sycamore'], ['tauri', 'tauri'], ['bevy', 'bevy'], ['tonic', 'tonic'], ['hyper', 'hyper'],
];
const PY_FRAMEWORKS: [string, DcFrameworkName][] = [['django', 'django'], ['fastapi', 'fastapi'], ['flask', 'flask'], ['litestar', 'litestar']];
const PY_LIBS = ['starlette', 'quart', 'sanic', 'tornado', 'pyramid', 'falcon', 'bottle', 'aiohttp', 'blacksheep'];
const PHP: [string, DcFrameworkName][] = [
  ['laravel/framework', 'laravel'], ['symfony/framework-bundle', 'symfony'], ['codeigniter4/framework', 'codeigniter'], ['yiisoft/yii2', 'yii'],
  ['cakephp/cakephp', 'cakephp'], ['slim/slim', 'slim'], ['drupal/core', 'drupal'], ['drupal/core-recommended', 'drupal'], ['joomla/joomla-cms', 'joomla'],
];

/** The framework of the app in `dir` (null: none recognised). */
export function detectFramework(dir: string): DcFramework | null {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const has = (n: string) => n in deps;
    const fw: DcFrameworkName = has('nuxt') ? 'nuxt' : has('next') ? 'next' : has('@angular/core') ? 'angular' : has('@nestjs/core') ? 'nestjs' : has('astro') ? 'astro' : has('@sveltejs/kit') ? 'sveltekit'
      : has('@tanstack/react-start') || has('@tanstack/start') ? 'tanstack-start' : has('vite') && has('vue') ? 'vite-vue' : has('vite') && has('react') ? 'vite-react' : has('vite') && has('svelte') ? 'vite-svelte' : has('vite') ? 'vite' : has('express') ? 'express' : 'node';
    const library = has('electron') ? 'electron' : has('fastify') ? 'fastify' : has('hono') ? 'hono' : has('koa') ? 'koa' : fw === 'express' ? 'express' : null;
    return { framework: fw, library };
  }
  const composer = readJson<{ require?: Record<string, string> }>(join(dir, 'composer.json'));
  if (composer || existsSync(join(dir, 'wp-config.php')) || existsSync(join(dir, 'wp-includes'))) {
    if (existsSync(join(dir, 'wp-includes')) || existsSync(join(dir, 'wp-config.php'))) return { framework: 'wordpress', library: null };
    const req = composer?.require ?? {};
    const hit = PHP.find(([n]) => n in req);
    return { framework: hit?.[1] ?? 'php', library: null };
  }
  const gomod = readText(join(dir, 'go.mod'));
  if (gomod) return { framework: 'go', library: GO_LIBS.find(([re]) => re.test(gomod))?.[1] ?? null };
  const cargo = readText(join(dir, 'Cargo.toml'));
  if (cargo) {
    const lib = RUST_LIBS.find(([crate]) => new RegExp(`^\\s*${crate.replace('-', '[-_]')}\\s*=`, 'm').test(cargo));
    return { framework: 'rust', library: lib?.[1] ?? null };
  }
  let py = ['requirements.txt', 'requirements-prod.txt', 'pyproject.toml', 'Pipfile', 'setup.py'].map((f) => readText(join(dir, f))).join('\n').toLowerCase();
  try {
    for (const f of readdirSync(join(dir, 'requirements'))) py += readText(join(dir, 'requirements', f)).toLowerCase();
  } catch {
    /* no requirements folder */
  }
  if (py.trim() || existsSync(join(dir, 'manage.py'))) {
    if (existsSync(join(dir, 'manage.py'))) return { framework: 'django', library: null };
    const word = (n: string) => new RegExp(`(^|[\\s"'\\[,])${n}([\\s=<>~!\\[;"',]|$)`, 'm').test(py);
    const fw = PY_FRAMEWORKS.find(([n]) => word(n));
    return { framework: fw?.[1] ?? 'python', library: fw ? null : (PY_LIBS.find(word) ?? null) };
  }
  return null;
}

/**
 * A build's framework: a monorepo builds from the workspace root (`context: .`) with the app's own Dockerfile
 * (`dockerfile: apps/web/Dockerfile`), so the Dockerfile's folder is looked at first — the root package.json of a bun /
 * npm workspace names no framework. Then the folders between it and the context, then the context itself.
 */
function detectBuild(context: string, dockerfile?: string): DcFramework | null {
  const df = dockerfile ? (isAbsolute(dockerfile) ? dockerfile : join(context, dockerfile)) : null;
  const dirs: string[] = [];
  for (let d = df ? dirname(df) : context; d.startsWith(context) && d.length >= context.length; d = dirname(d)) {
    dirs.push(d);
    if (d === context) break;
  }
  if (!dirs.includes(context)) dirs.push(context);
  const found = dirs.map((d) => detectFramework(d)).filter((f): f is DcFramework => f !== null);
  // A specific framework wins over a bare language (node, php, python) found higher up.
  return found.find((f) => !['node', 'php', 'python'].includes(f.framework) || f.library) ?? found[0] ?? null;
}

interface Cached {
  key: string;
  services: Record<string, DcFramework | null>;
}
const cache = new Map<string, Cached>();
const pending = new Set<string>();

/** project/service → framework, for the list; unknown projects are worked out in the background (`onLearned`). */
export function frameworkOf(project: string | null, service: string | null): DcFramework | null {
  if (!project || !service) return null;
  return cache.get(project)?.services[service] ?? null;
}

/** Learns the frameworks of a project's services from its compose files (once per change of those files). */
export async function learnProject(project: string, files: string[], onLearned: () => void): Promise<void> {
  if (!files.length || !cliInstalled()) return;
  const key = files.map((f) => `${f}:${existsSync(f) ? statSync(f).mtimeMs : 0}`).join('|');
  if (cache.get(project)?.key === key || pending.has(project)) return;
  pending.add(project);
  try {
    const r = await run(composeBin(), [...files.flatMap((f) => ['-f', f]), '-p', project, 'config', '--format', 'json', '--no-interpolate'], { cwd: dirname(files[0]), env: { ...process.env, DOCKER_HOST: dockerHost() }, timeout: 30_000 });
    const cfg = r.code === 0 ? (JSON.parse(r.stdout) as { services?: Record<string, { build?: { context?: string; dockerfile?: string } | string }> }) : null;
    const services: Record<string, DcFramework | null> = {};
    for (const [name, s] of Object.entries(cfg?.services ?? {})) {
      const ctx = typeof s.build === 'string' ? s.build : s.build?.context;
      const dockerfile = typeof s.build === 'object' ? s.build.dockerfile : undefined;
      services[name] = ctx && existsSync(ctx) ? detectBuild(ctx, dockerfile) : null;
    }
    cache.set(project, { key, services });
    onLearned();
  } catch {
    cache.set(project, { key, services: {} });
  } finally {
    pending.delete(project);
  }
}
