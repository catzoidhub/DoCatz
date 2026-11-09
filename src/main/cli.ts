import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildxPackage, composePackage, dockerPackage, VERSIONS } from './components';
import { fetchPinned } from './download';
import { binDir, DOCATZ_HOME, docatzDir, dockerHost, exe } from './paths';
import { isLinux, isWin } from './platform';
import { lastLine, run } from './proc';

/**
 * DoCatz's own docker, docker compose and docker buildx (DoCatz TODO #7) in ~/.docatz/bin, and the `docatz` docker
 * context (#6). Nothing outside ~/.docatz changes unless the user says so: the context is made (one folder under
 * ~/.docker/contexts) but only becomes the current one with "Use DoCatz as the default"; PATH changes only with "Add
 * to PATH". A docker CLI the user already has keeps working — the context points it at DoCatz.
 */

const PLUGINS = () => docatzDir('cli-plugins');
const VERSION_FILE = () => join(binDir(), '.versions.json');
const DOCKER_DIR = () => process.env.DOCKER_CONFIG || join(homedir(), '.docker');
const CONTEXT = 'docatz';

export const composeBin = () => join(PLUGINS(), isWin ? 'docker-compose.exe' : 'docker-compose');
export const dockerBin = () => exe('docker');

export function cliVersion(): string {
  try {
    return (JSON.parse(readFileSync(VERSION_FILE(), 'utf8')) as { docker?: string }).docker ?? '';
  } catch {
    return '';
  }
}
export const cliInstalled = () => existsSync(dockerBin()) && existsSync(composeBin()) && cliVersion() === VERSIONS.docker;

/** Downloads and installs the three CLIs; `progress` gets a line and a fraction. */
export async function installCli(progress: (text: string, fraction?: number) => void, signal: AbortSignal): Promise<void> {
  const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;
  const docker = await fetchPinned(dockerPackage(), (f, got, total) => progress(`Docker CLI ${VERSIONS.docker}: ${mb(got)} of ${mb(total)}`, f), signal);
  const tmp = join(tmpdir(), `docatz-cli-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // Windows 10+ ships bsdtar as tar.exe, which reads .zip too.
  const x = await run(isWin ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar', ['-xf', docker, '-C', tmp], { timeout: 120_000 });
  if (x.code !== 0) throw new Error(`The Docker CLI could not be unpacked: ${lastLine(x.stderr)}`);
  const unpacked = join(tmp, 'docker', isWin ? 'docker.exe' : 'docker');
  copyFileSync(unpacked, `${dockerBin()}.new`);
  renameSync(`${dockerBin()}.new`, dockerBin());
  rmSync(tmp, { recursive: true, force: true });

  const compose = await fetchPinned(composePackage(), (f, got, total) => progress(`Docker Compose ${VERSIONS.compose}: ${mb(got)} of ${mb(total)}`, f), signal);
  copyFileSync(compose, composeBin());
  const buildx = await fetchPinned(buildxPackage(), (f, got, total) => progress(`Docker Buildx ${VERSIONS.buildx}: ${mb(got)} of ${mb(total)}`, f), signal);
  const buildxBin = join(PLUGINS(), isWin ? 'docker-buildx.exe' : 'docker-buildx');
  copyFileSync(buildx, buildxBin);
  if (!isWin) for (const f of [dockerBin(), composeBin(), buildxBin]) chmodSync(f, 0o755);
  // `docker-compose` as a command of its own too (older scripts call it that way).
  const standalone = exe('docker-compose');
  copyFileSync(composeBin(), standalone);
  if (!isWin) chmodSync(standalone, 0o755);
  writeFileSync(VERSION_FILE(), JSON.stringify({ docker: VERSIONS.docker, compose: VERSIONS.compose, buildx: VERSIONS.buildx }));
  addPluginDir();
}

/** The docker CLI finds compose / buildx in ~/.docatz/cli-plugins (`cliPluginsExtraDirs` in ~/.docker/config.json). */
function addPluginDir(): void {
  const cfg = readDockerConfig();
  const dirs = new Set<string>(Array.isArray(cfg.cliPluginsExtraDirs) ? (cfg.cliPluginsExtraDirs as string[]) : []);
  if (dirs.has(PLUGINS())) return;
  dirs.add(PLUGINS());
  writeDockerConfig({ ...cfg, cliPluginsExtraDirs: [...dirs] });
}

/** Another docker on this computer (Docker Desktop, OrbStack, Homebrew), for "your own docker keeps working". */
export function otherDocker(): string | null {
  const places = isWin
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
    : isLinux
      ? ['/usr/bin/docker', '/usr/local/bin/docker']
      : ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', join(homedir(), '.orbstack', 'bin', 'docker')];
  return places.find(existsSync) ?? null;
}

// ---------------------------------------------------------------- PATH

const MARK_START = '# >>> DoCatz >>>';
const MARK_END = '# <<< DoCatz <<<';
/** macOS terminals are login shells (.zprofile); Linux ones are not (.bashrc, .zshrc). */
const PROFILES = () => (isLinux ? [join(homedir(), '.bashrc'), join(homedir(), '.zshrc')] : [join(homedir(), '.zprofile'), join(homedir(), '.bash_profile')]);

export async function inPath(): Promise<boolean> {
  if (isWin) {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"], { timeout: 15_000 });
    return r.stdout.split(';').some((p) => p.trim().toLowerCase() === binDir().toLowerCase());
  }
  return PROFILES().some((f) => existsSync(f) && readFileSync(f, 'utf8').includes(MARK_START));
}

/** Puts ~/.docatz/bin first on PATH for new terminals (macOS: .zprofile / .bash_profile; Linux: .bashrc / .zshrc; Windows: the user's Path). */
export async function setPath(on: boolean): Promise<void> {
  if (isWin) {
    const ps = on
      ? `$p=[Environment]::GetEnvironmentVariable('Path','User'); $d=$env:DOCATZ_BIN; if (-not ($p -split ';' | Where-Object { $_ -ieq $d })) { [Environment]::SetEnvironmentVariable('Path', ($d + ';' + $p).TrimEnd(';'), 'User') }`
      : `$p=[Environment]::GetEnvironmentVariable('Path','User'); $d=$env:DOCATZ_BIN; [Environment]::SetEnvironmentVariable('Path', (($p -split ';' | Where-Object { $_ -and ($_ -ine $d) }) -join ';'), 'User')`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30_000, env: { ...process.env, DOCATZ_BIN: binDir() } });
    if (r.code !== 0) throw new Error(`Windows did not take the change: ${lastLine(r.stderr)}`);
    return;
  }
  const block = `${MARK_START}\nexport PATH="$HOME/${join(DOCATZ_HOME, 'bin').slice(homedir().length + 1)}:$PATH"\n${MARK_END}\n`;
  for (const f of PROFILES()) {
    const had = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const without = had.replace(new RegExp(`\\n?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`, 'g'), '\n').replace(/\n{3,}$/, '\n\n');
    if (!on && without === had) continue;
    if (!existsSync(f) && !on) continue;
    // .bash_profile only when it exists (making one would stop bash from reading .profile); .zshrc only for zsh users.
    if (on && !existsSync(f) && (f.endsWith('.bash_profile') || f.endsWith('.zshrc'))) continue;
    writeFileSync(f, on ? `${without.replace(/\n*$/, '\n')}\n${block}` : without);
  }
}

// ---------------------------------------------------------------- docker context

function readDockerConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(DOCKER_DIR(), 'config.json'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function writeDockerConfig(cfg: Record<string, unknown>): void {
  const file = join(DOCKER_DIR(), 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.docatz.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, '\t')}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
const metaDir = () => join(DOCKER_DIR(), 'contexts', 'meta', createHash('sha256').update(CONTEXT).digest('hex'));

export function contextState(): { exists: boolean; current: boolean; currentName: string } {
  const name = process.env.DOCKER_CONTEXT || (readDockerConfig().currentContext as string | undefined) || 'default';
  return { exists: existsSync(join(metaDir(), 'meta.json')), current: name === CONTEXT, currentName: name };
}

/** Writes the `docatz` context (the same files `docker context create` writes), and optionally makes it current. */
export function setContext(use: boolean | null): void {
  mkdirSync(metaDir(), { recursive: true });
  writeFileSync(join(metaDir(), 'meta.json'), JSON.stringify({ Name: CONTEXT, Metadata: { Description: 'DoCatz' }, Endpoints: { docker: { Host: dockerHost(), SkipTLSVerify: false } } }));
  if (use === null) return;
  const cfg = readDockerConfig();
  if (use) cfg.currentContext = CONTEXT;
  else if (cfg.currentContext === CONTEXT) delete cfg.currentContext;
  writeDockerConfig(cfg);
}

/** Uninstall: the context and DoCatz's plugin folder in ~/.docker/config.json go; anything else there stays. */
export function removeContext(): void {
  rmSync(metaDir(), { recursive: true, force: true });
  const cfg = readDockerConfig();
  if (!Object.keys(cfg).length) return;
  if (cfg.currentContext === CONTEXT) delete cfg.currentContext;
  if (Array.isArray(cfg.cliPluginsExtraDirs)) cfg.cliPluginsExtraDirs = (cfg.cliPluginsExtraDirs as string[]).filter((d) => d !== PLUGINS());
  writeDockerConfig(cfg);
}
