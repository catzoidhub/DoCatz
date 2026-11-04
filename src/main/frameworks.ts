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
  // First: Goravel requires Gin (and others) itself.
  [/github\.com\/goravel\/framework\b/, 'goravel'],
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

/** Plain projects with no manifest, recognised like DevCatz: the file that serves something. */
const JS_ENTRIES = ['server', 'index', 'app', 'main'].flatMap((n) => ['js', 'mjs', 'cjs', 'ts'].map((x) => `${n}.${x}`));
const JS_LISTENS = /\b(?:createServer|Bun\.serve|Deno\.serve)\s*\(|\.listen\s*\(/;
const PY_ENTRIES = ['main.py', 'app.py', 'server.py', 'run.py'];
const PY_SERVES = /\b(?:http\.server|socketserver|wsgiref|aiohttp|tornado|bottle)\b|\b(?:from|import)\s+(?:flask|fastapi|uvicorn)\b|\bserve_forever\(/;

function plainProject(dir: string): DcFramework | null {
  if (PY_ENTRIES.some((f) => PY_SERVES.test(readText(join(dir, f))))) return { framework: 'python', library: null };
  const js = JS_ENTRIES.map((f) => readText(join(dir, f))).find((t) => JS_LISTENS.test(t));
  if (js !== undefined) return { framework: 'node', library: /\bDeno\.serve\s*\(/.test(js) ? 'deno' : /\bBun\.serve\s*\(/.test(js) ? 'bun' : null };
  if (/\bnet\/http\b|\bnet\.Listen\(/.test(readText(join(dir, 'main.go')))) return { framework: 'go', library: null };
  return existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'index.htm')) ? { framework: 'static', library: null } : null;
}

/** The framework of the app in `dir` (null: none recognised). */
export function detectFramework(dir: string): DcFramework | null {
  // PHP first: a Laravel (or Symfony …) app has a package.json too, for its Vite assets — DevCatz calls it Laravel,
  // with Vite only serving assets behind it.
  const composer = readJson<{ require?: Record<string, string> }>(join(dir, 'composer.json'));
  if (existsSync(join(dir, 'wp-includes')) || existsSync(join(dir, 'wp-config.php'))) return { framework: 'wordpress', library: null };
  if (existsSync(join(dir, 'artisan')) && composer) return { framework: 'laravel', library: null };
  const php = composer ? PHP.find(([n]) => n in (composer.require ?? {}))?.[1] : undefined;
  if (php) return { framework: php, library: null };
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const has = (n: string) => n in deps;
    const fw: DcFrameworkName = has('nuxt') ? 'nuxt' : has('next') ? 'next' : has('@angular/core') ? 'angular' : has('@nestjs/core') ? 'nestjs' : has('astro') ? 'astro' : has('@sveltejs/kit') ? 'sveltekit'
      : has('@tanstack/react-start') || has('@tanstack/start') ? 'tanstack-start' : has('vite') && has('vue') ? 'vite-vue' : has('vite') && has('react') ? 'vite-react' : has('vite') && has('svelte') ? 'vite-svelte' : has('vite') ? 'vite' : has('express') ? 'express' : 'node';
    // A PHP app whose package.json only builds assets (Vite, no app framework of its own) is still a PHP app.
    if (composer && ['vite', 'node', 'vite-vue', 'vite-react', 'vite-svelte'].includes(fw)) return { framework: 'php', library: null };
    const library = has('electron') ? 'electron' : has('fastify') ? 'fastify' : has('hono') ? 'hono' : has('koa') ? 'koa' : fw === 'express' ? 'express' : null;
    return { framework: fw, library };
  }
  if (composer) return { framework: 'php', library: null };
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
  return plainProject(dir);
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

/**
 * The apps of a bun / npm / yarn / pnpm workspace at `root` (`apps/*`, `packages/*`, no deep globs), as DevCatz lists
 * them: every folder a pattern names, with its package name when it has a package.json.
 */
function workspaceApps(root: string): { dir: string; rel: string; name: string | null }[] {
  const pkg = readJson<{ workspaces?: string[] | { packages?: string[] } }>(join(root, 'package.json'));
  const patterns = Array.isArray(pkg?.workspaces) ? [...pkg.workspaces] : [...(pkg?.workspaces?.packages ?? [])];
  for (const m of readText(join(root, 'pnpm-workspace.yaml')).matchAll(/^\s*-\s*['"]?([^'"\n#]+)['"]?/gm)) patterns.push(m[1].trim());
  const out: { dir: string; rel: string; name: string | null }[] = [];
  const add = (rel: string) => {
    const dir = join(root, rel);
    out.push({ dir, rel, name: readJson<{ name?: string }>(join(dir, 'package.json'))?.name ?? null });
  };
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const clean = pattern.replace(/\/+$/, '');
    if (/\/\*+$/.test(clean)) {
      const base = clean.replace(/\/\*+$/, '');
      try {
        for (const e of readdirSync(join(root, base)).sort()) if (e !== 'node_modules' && !e.startsWith('.') && statSync(join(root, base, e)).isDirectory()) add(`${base}/${e}`);
      } catch {
        /* no such folder */
      }
    } else if (!clean.includes('*') && existsSync(join(root, clean))) add(clean);
  }
  return out;
}

/**
 * The part of a multi-stage Dockerfile that builds `target`: its stage and the stages it starts from or copies from
 * (`FROM deps AS web-build`, `COPY --from=web-build`). The whole file without a target.
 */
function stageText(text: string, target?: string): string {
  if (!target) return text;
  const stages = new Map<string, string>();
  const parts = text.split(/^(?=FROM\s)/im);
  for (const part of parts) {
    const m = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(part);
    if (m?.[2]) stages.set(m[2].toLowerCase(), part);
  }
  if (!stages.has(target.toLowerCase())) return text;
  const seen = new Set<string>();
  const visit = (name: string) => {
    const part = stages.get(name);
    if (!part || seen.has(name)) return;
    seen.add(name);
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)/i.exec(part)?.[1].toLowerCase();
    if (from) visit(from);
    for (const m of part.matchAll(/--from=(\S+)/gi)) visit(m[1].toLowerCase());
  };
  visit(target.toLowerCase());
  return [...seen].map((n) => stages.get(n)).join('\n');
}

interface ServiceCfg {
  build?: { context?: string; dockerfile?: string; target?: string } | string;
  image?: string;
  container_name?: string;
  working_dir?: string;
  entrypoint?: string[] | string | null;
  command?: string[] | string | null;
}

/**
 * Which workspace app a service of a monorepo runs: what its Dockerfile, entrypoint / command and the scripts they
 * start say (`apps/api`, `--filter @scope/api`), else its service / container / image name (`api`, `halo-web-dev`).
 */
function workspaceAppOf(root: string, name: string, svc: ServiceCfg, dockerfile: string | null): string | null {
  // apps with a framework of their own first: a shared package (types, ui) is only built on the way to the app
  const listed = workspaceApps(root);
  // apps/* and services/* too, workspace members or not (a Go API next to a bun workspace of apps/web)
  for (const base of ['apps', 'services']) {
    try {
      for (const e of readdirSync(join(root, base)).sort()) {
        const rel = `${base}/${e}`;
        if (!e.startsWith('.') && e !== 'node_modules' && statSync(join(root, rel)).isDirectory() && !listed.some((a) => a.rel === rel)) listed.push({ dir: join(root, rel), rel, name: readJson<{ name?: string }>(join(root, rel, 'package.json'))?.name ?? null });
      }
    } catch {
      /* no such folder */
    }
  }
  const known = listed.map((a) => ({ ...a, fw: detectFramework(a.dir) })).filter((a) => a.fw);
  const real = known.filter((a) => a.fw!.framework !== 'node' || a.fw!.library);
  const apps = real.length ? real : known;
  if (!apps.length) return null;
  const words = [svc.entrypoint, svc.command].flatMap((x) => (Array.isArray(x) ? x : x ? x.split(/\s+/) : []));
  // a script the container starts, read from the project (/app/docker/dev-api.sh → <root>/docker/dev-api.sh)
  const scripts = words.filter((w) => /\.(sh|bash|mjs|js|ts)$/.test(w)).map((w) => readText(join(root, w.replace(new RegExp(`^${(svc.working_dir ?? '/app').replace(/\/+$/, '')}/`), '').replace(/^\.?\//, ''))));
  const hints = [dockerfile ? stageText(readText(dockerfile), typeof svc.build === 'object' ? svc.build.target : undefined) : '', words.join(' '), ...scripts].join('\n');
  const score = (a: { rel: string; name: string | null }) => (hints.split(a.rel).length - 1) * 2 + (a.name ? hints.split(a.name).length - 1 : 0) * 2;
  const best = apps.map((a) => ({ a, n: score(a) })).sort((x, y) => y.n - x.n)[0];
  if (best.n > 0 && apps.filter((a) => score(a) === best.n).length === 1) return best.a.dir;
  const tokens = new Set([name, svc.container_name ?? '', svc.image ?? ''].flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
  const byName = apps.filter((a) => tokens.has(a.rel.split('/').pop()!.toLowerCase()));
  return byName.length === 1 ? byName[0].dir : null;
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
    if (r.code !== 0) console.warn(`frameworks of ${project}: compose config failed`, r.stderr?.slice(0, 300));
    const cfg = r.code === 0 ? (JSON.parse(r.stdout) as { services?: Record<string, ServiceCfg> }) : null;
    const services: Record<string, DcFramework | null> = {};
    for (const [name, s] of Object.entries(cfg?.services ?? {})) {
      const ctx = typeof s.build === 'string' ? s.build : s.build?.context;
      const dockerfile = typeof s.build === 'object' ? s.build.dockerfile : undefined;
      if (!ctx || !existsSync(ctx)) {
        services[name] = null;
        continue;
      }
      // A monorepo built from its root (`context: .`, a shared docker/ folder): the workspace app the service runs.
      const app = workspaceAppOf(ctx, name, s, dockerfile ? (isAbsolute(dockerfile) ? dockerfile : join(ctx, dockerfile)) : null);
      services[name] = (app && detectFramework(app)) || detectBuild(ctx, dockerfile);
    }
    cache.set(project, { key, services });
    onLearned();
  } catch (e) {
    console.warn(`frameworks of ${project}:`, (e as Error).message);
    cache.set(project, { key, services: {} });
  } finally {
    pending.delete(project);
  }
}
