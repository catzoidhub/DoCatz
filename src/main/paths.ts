import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isLinux, isWin } from './platform';

/**
 * Where DoCatz keeps the engine (DoCatz TODO #6 / #7): one folder in the home folder, the same on macOS and Windows,
 * so the docker context, the socket and the CLIs have short, stable paths.
 *   ~/.docatz/bin        docker, docker-compose, docker-buildx (+ lima on macOS)
 *   ~/.docatz/run        docker.sock (macOS: a link to the VM's forwarded socket)
 *   ~/.docatz/vm         the VM: LIMA_HOME on macOS, the WSL distro's disk on Windows
 *   ~/.docatz/downloads  finished downloads, checked against their pinned SHA-256
 * DOCATZ_HOME moves all of it (tests).
 */

export const DOCATZ_HOME = process.env.DOCATZ_HOME || join(homedir(), '.docatz');

export function docatzDir(...parts: string[]): string {
  const dir = join(DOCATZ_HOME, ...parts);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const binDir = () => docatzDir('bin');
export const exe = (name: string) => join(binDir(), isWin ? `${name}.exe` : name);

/**
 * The engine's socket on the host: a Unix socket on macOS, a named pipe on Windows, and on Linux the system Docker
 * Engine's own socket (#101: no VM there; DOCATZ_LINUX_SOCKET moves it, tests).
 */
export const ENGINE_PIPE = '\\\\.\\pipe\\docatz_engine';
export const LINUX_SOCKET = process.env.DOCATZ_LINUX_SOCKET || '/var/run/docker.sock';
export const socketPath = () => (isWin ? ENGINE_PIPE : isLinux ? LINUX_SOCKET : join(docatzDir('run'), 'docker.sock'));
/** DOCKER_HOST for the docker CLI and the context. */
export const dockerHost = () => (isWin ? 'npipe:////./pipe/docatz_engine' : `unix://${socketPath()}`);
