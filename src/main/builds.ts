import type { DcBuild, DcBuildDetail } from '@shared/types';
import { cliInstalled, dockerBin } from './cli';
import { dockerHost } from './paths';
import { lastLine, run } from './proc';

/**
 * Builds (as OrbStack's Builds): BuildKit's own build history on the DoCatz engine, through DoCatz's buildx
 * (`docker buildx history ls / inspect / logs / rm`). Every `docker build` and compose build lands here — from a
 * terminal, DevCatz's Build & Up or DoCatz itself.
 */

const env = () => ({ ...process.env, DOCKER_HOST: dockerHost(), BUILDX_NO_DEFAULT_ATTESTATIONS: '1' });
async function buildx(args: string[], timeout = 30_000, both = false) {
  if (!cliInstalled()) throw new Error('docker and buildx are not installed yet — start the engine once');
  // Run from / so the paths buildx writes relative to the working folder become absolute again (abs() below).
  const r = await run(dockerBin(), ['buildx', 'history', ...args], { env: env(), timeout, cwd: '/' });
  if (r.code !== 0) throw new Error(lastLine(r.stderr) || `docker buildx history exited ${r.code}`);
  // `history logs` writes the build's progress to stderr, as `docker build` does.
  return both ? r.stdout + r.stderr : r.stdout;
}
/** "default/default/<id>" → "<id>" (inspect / logs / rm take the short ref). */
const shortRef = (ref: string) => ref.split('/').pop() ?? ref;
/** A local context buildx wrote relative to the working folder (/); a Git or HTTP context stays as it is. */
const abs = (p: string) => (!p || p.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[A-Za-z]:[\\/]/.test(p) || process.platform === 'win32' ? p : `/${p}`);

export async function listBuilds(): Promise<DcBuild[]> {
  const out = await buildx(['ls', '--format', 'json', '--no-trunc']);
  return out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as { ref: string; name: string; status: string; created_at: string; completed_at?: string; total_steps: number; completed_steps: number; cached_steps: number; error?: string })
    .map((b) => ({
      ref: shortRef(b.ref),
      name: b.name || '(unnamed)',
      status: /error|fail/i.test(b.status) ? 'failed' : /cancel/i.test(b.status) ? 'cancelled' : /complete/i.test(b.status) ? 'completed' : 'running',
      createdAt: Date.parse(b.created_at),
      durationMs: b.completed_at ? Math.max(0, Date.parse(b.completed_at) - Date.parse(b.created_at)) : null,
      steps: { total: b.total_steps, completed: b.completed_steps, cached: b.cached_steps },
      error: b.error ?? null,
    }) satisfies DcBuild)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function buildDetail(ref: string): Promise<DcBuildDetail> {
  if (!/^[a-z0-9]{10,40}$/.test(ref)) throw new Error('Unknown build');
  const d = JSON.parse(await buildx(['inspect', ref, '--format', 'json'])) as {
    Name: string; Context?: string; Dockerfile?: string; Target?: string; Platform?: string[]; StartedAt: string; CompletedAt?: string; Duration?: number; Status: string; Error?: { Message?: string } | string;
    NumCompletedSteps: number; NumTotalSteps: number; NumCachedSteps: number; Materials?: { URI: string }[]; Attachments?: { Digest: string; Type: string }[];
  };
  const err = typeof d.Error === 'string' ? d.Error : (d.Error?.Message ?? null);
  return {
    ref,
    name: d.Name || '(unnamed)',
    status: /error|fail/i.test(d.Status) || err ? 'failed' : /cancel/i.test(d.Status) ? 'cancelled' : /complete/i.test(d.Status) ? 'completed' : 'running',
    createdAt: Date.parse(d.StartedAt),
    durationMs: d.Duration ? Math.round(d.Duration / 1e6) : null,
    steps: { total: d.NumTotalSteps, completed: d.NumCompletedSteps, cached: d.NumCachedSteps },
    error: err,
    context: abs(d.Context ?? ''),
    dockerfile: d.Dockerfile ?? '',
    target: d.Target ?? '',
    platforms: d.Platform ?? [],
    bases: (d.Materials ?? []).map((m) => decodeURIComponent(m.URI.replace(/^pkg:docker\//, '').replace(/\?.*$/, ''))),
    image: d.Attachments?.find((a) => a.Type.includes('image.index') || a.Type.includes('image.manifest'))?.Digest ?? null,
  };
}

export async function buildLogs(ref: string): Promise<string> {
  if (!/^[a-z0-9]{10,40}$/.test(ref)) throw new Error('Unknown build');
  return (await buildx(['logs', ref], 60_000, true)).slice(-400_000);
}

export async function removeBuild(ref: string): Promise<void> {
  if (!/^[a-z0-9]{10,40}$/.test(ref)) throw new Error('Unknown build');
  await buildx(['rm', ref]);
}
