import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DcApiSource } from '@shared/types';

/**
 * Whether a compose project has routes DialCatz can import (#25; user 2026-11-03: "hanya untuk projek yang memiliki API
 * … kecuali misal laravel yang sudah punya route list"), so Open in DialCatz shows only there:
 * - a Laravel service (DialCatz runs `php artisan route:list` in its container), or a Goravel one (its own program's
 *   `artisan route:list`);
 * - an OpenAPI / Swagger file in the project's folder;
 * - a framework that serves its own OpenAPI document (FastAPI and Litestar always; NestJS with @nestjs/swagger,
 *   Express / Fastify / Hono with their OpenAPI packages, Django with drf-spectacular or drf-yasg, Flask with
 *   flasgger / flask-smorest, Go with swaggo or huma …), found in the project's dependency files.
 * A web site with a database and nothing of these has no routes to import, so no button. Kept per folder for a minute.
 */

const SKIP = new Set(['node_modules', 'vendor', '.git', '.next', '.nuxt', '.output', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', 'storage', 'public']);
const SPEC = /^(openapi|swagger)([\w.-]*)\.(json|ya?ml)$/i;
/** Dependency files, and what in them means "serves an OpenAPI document". */
const SERVED: { file: RegExp; hint: RegExp; what: string }[] = [
  { file: /^package\.json$/, hint: /"(@nestjs\/swagger|swagger-ui-express|swagger-jsdoc|@fastify\/swagger|hono-openapi|@hono\/zod-openapi|@hono\/swagger-ui|express-openapi|tsoa|@asteasolutions\/zod-to-openapi|elysia-swagger|@elysiajs\/swagger)"/, what: 'OpenAPI document the app serves' },
  { file: /^(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/, hint: /\b(fastapi|litestar|drf-spectacular|drf-yasg|flasgger|flask-smorest|apispec|django-ninja|connexion)\b/i, what: 'OpenAPI document the app serves' },
  { file: /^go\.mod$/, hint: /(swaggo\/swag|danielgtaylor\/huma|getkin\/kin-openapi|ogen-go\/ogen|go-swagger)/, what: 'OpenAPI document the app serves' },
  { file: /^composer\.json$/, hint: /"(darkaonline\/l5-swagger|nelmio\/api-doc-bundle|api-platform\/core|zircote\/swagger-php|dedoc\/scramble)"/, what: 'OpenAPI document the app serves' },
  { file: /^Cargo\.toml$/, hint: /\b(utoipa|aide|poem-openapi|paperclip|okapi)\b/, what: 'OpenAPI document the app serves' },
  // Ruby (#99): rswag (Rails), grape-swagger, oas_rails, rspec-openapi, rage's own OpenAPI.
  { file: /^Gemfile$/, hint: /^\s*gem\s+['"](rswag|rswag-api|rswag-ui|grape-swagger|oas_rails|rspec-openapi|rage-rb)['"]/m, what: 'OpenAPI document the app serves' },
];
const ALWAYS = new Set(['fastapi', 'litestar']);

const cache = new Map<string, { at: number; v: DcApiSource | null }>();

/**
 * An OpenAPI file in the service's own folder — <dir>/<service>, apps/<service>, services/<service>, or their docs/
 * (as DialCatz's Import from DoCatz looks): such a service has routes even when it runs a plain image.
 */
export function serviceSpec(dir: string | null, service: string | null): string | null {
  if (!dir || !service || !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(service)) return null;
  for (const base of [service, `apps/${service}`, `services/${service}`]) {
    for (const sub of ['', 'docs']) {
      const d = join(dir, base, sub);
      try {
        const hit = readdirSync(d).find((n) => SPEC.test(n));
        if (hit) return relative(dir, join(d, hit));
      } catch {
        /* no such folder */
      }
    }
  }
  return null;
}

/** The project's API for DialCatz, or null. `frameworks`: what its services are built from (container marks). */
export function apiSource(dir: string | null, frameworks: string[]): DcApiSource | null {
  if (frameworks.includes('laravel')) return { how: 'laravel', detail: 'Laravel’s route list' };
  if (frameworks.includes('goravel')) return { how: 'goravel', detail: 'Goravel’s route list' };
  const always = frameworks.find((f) => ALWAYS.has(f));
  if (always) return { how: 'served', detail: `${always === 'fastapi' ? 'FastAPI' : 'Litestar'}’s OpenAPI document` };
  if (!dir) return null;
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let found: DcApiSource | null = null;
  let served: DcApiSource | null = null;
  let seen = 0;
  const walk = (d: string, depth: number) => {
    if (found || depth > 4 || seen > 4000) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (found) return;
      seen++;
      const p = join(d, n);
      if (SPEC.test(n)) {
        found = { how: 'file', detail: relative(dir, p) };
        return;
      }
      const dep = !served && SERVED.find((s) => s.file.test(n));
      if (dep) {
        try {
          if (statSync(p).size < 2_000_000 && dep.hint.test(readFileSync(p, 'utf8'))) served = { how: 'served', detail: `the ${dep.what} (${relative(dir, p)})` };
        } catch {
          /* unreadable: skip it */
        }
        continue;
      }
      if (SKIP.has(n) || n.startsWith('.')) continue;
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* gone or unreadable */
      }
    }
  };
  walk(dir, 0);
  const v = found ?? served;
  cache.set(dir, { at: Date.now(), v });
  return v;
}
