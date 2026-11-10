import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { userInfo } from 'node:os';
import type { EngineConfig } from '@shared/types';
import { Cancelled } from '../download';
import { runAsRootLinux, shq } from '../linuxadmin';
import { LINUX_SOCKET } from '../paths';
import { lastLine, run } from '../proc';
import type { Backend, BackendStatus, StepReporter } from './backend';

/**
 * Linux (DoCatz #101, user 2026-11-09): no VM — DoCatz's engine is the system's Docker Engine (apt docker.io + Compose
 * v2, or dnf moby-engine), started by systemd, the same daemon DevCatz installs (DevCatz docker.ts linuxDockerEngine).
 * One daemon per computer: bridge.json's engineEndpoint is its socket, so DevCatz does not offer it twice.
 * Start installs it when missing and starts it when stopped, through one password prompt (pkexec); the user joins the
 * docker group, and since that applies from the next login the socket gets an ACL for them at once.
 * CPU / memory / disk are the computer's own (no settings), and Reset is not DoCatz's to do: the data is the system's.
 */

const DOCKERD = ['/usr/bin/dockerd', '/usr/sbin/dockerd', '/usr/local/bin/dockerd', '/snap/bin/dockerd'];

async function systemctl(...args: string[]): Promise<string> {
  return (await run('systemctl', args, { timeout: 15_000 })).stdout.trim();
}

/** Nothing listens on the socket file (connection refused, or it is gone); permission errors count as someone there. */
function refused(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ path });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(2000, () => done(false));
    s.once('connect', () => done(false));
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' || e.code === 'ENOENT'));
  });
}

/** Can this user talk to the socket (docker group or the ACL)? */
async function socketOpen(): Promise<boolean> {
  return (await run('/bin/sh', ['-c', `[ -r ${shq(LINUX_SOCKET)} ] && [ -w ${shq(LINUX_SOCKET)} ]`], { timeout: 5000 })).code === 0;
}

export class LinuxBackend implements Backend {
  readonly id = 'system' as const;
  /** What a start shows: installing when Docker Engine is missing (user, 2026-11-10: a notice and a button for it). */
  get steps(): string[] {
    return this.installed()
      ? ['Start Docker Engine — your password', 'Connect to Docker']
      : ['Install Docker Engine and Docker Compose — your password, then a few minutes', 'Connect to Docker'];
  }

  /** The socket is a leftover nothing listens on (apt purge docker.io keeps /var/run/docker.sock until a reboot). */
  private deadSocket = false;

  private installed(): boolean {
    // DOCATZ_FAKE_NO_DOCKER: tests the "not installed" notice and Install on a computer that has it (the install
    // script then only adds what is missing).
    if (process.env.DOCATZ_FAKE_NO_DOCKER) return false;
    // A live socket counts too (Docker installed some other way): never install docker.io over it. A dead one with no
    // dockerd does not (found in the x64 VM, 2026-11-10: after a purge DoCatz offered Start instead of Install).
    return DOCKERD.some(existsSync) || (existsSync(LINUX_SOCKET) && !this.deadSocket);
  }

  /** Looks again whether a socket without dockerd is a leftover; installed() reads the answer. */
  private async probeSocket(): Promise<void> {
    this.deadSocket = !DOCKERD.some(existsSync) && existsSync(LINUX_SOCKET) && (await refused(LINUX_SOCKET));
  }

  private async version(): Promise<string> {
    const bin = DOCKERD.find(existsSync);
    if (!bin) return '';
    const m = /version ([\d.]+)/.exec((await run(bin, ['--version'], { timeout: 10_000 })).stdout);
    return m ? `Docker Engine ${m[1]}` : 'Docker Engine';
  }

  async status(): Promise<BackendStatus> {
    await this.probeSocket();
    const base = { manager: await this.version(), dir: this.installed() ? '/var/lib/docker' : '', running: null };
    if (!this.installed()) return { ...base, status: 'missing', message: 'DoCatz runs your containers on Docker Engine, which is not on this computer yet. DoCatz can install it from your package manager (docker.io and Docker Compose): one password prompt, then a few minutes.' };
    const active = await systemctl('is-active', 'docker');
    if (active === 'activating') return { ...base, status: 'starting', message: '' };
    if (active === 'deactivating') return { ...base, status: 'stopping', message: '' };
    if (active !== 'active') return { ...base, status: 'stopped', message: active === 'failed' ? 'Docker Engine failed to start: see the engine log.' : '' };
    if (!(await socketOpen())) return { ...base, status: 'stopped', message: 'Docker Engine runs, but this user cannot reach it yet: Start gives you access (one password prompt).' };
    return { ...base, status: 'running', message: '' };
  }

  async start(_config: EngineConfig, r: StepReporter): Promise<void> {
    await this.probeSocket();
    r.step(0, this.installed() ? 'Waiting for your password' : 'Waiting for your password, then installing (a few minutes)');
    const user = shq(userInfo().username);
    const sock = shq(LINUX_SOCKET);
    const install = this.installed()
      ? ''
      : `if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq docker.io >/dev/null 2>&1 || { apt-get update -qq >/dev/null && apt-get install -y -qq docker.io >/dev/null; }
  for p in docker-compose-v2 docker-compose-plugin; do apt-get install -y -qq "$p" >/dev/null 2>&1 && break; done
  apt-get install -y -qq acl >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q moby-engine docker-compose acl >/dev/null
else
  echo "No apt-get or dnf here: install Docker Engine from docs.docker.com/engine/install" >&2; exit 1
fi
`;
    const res = await runAsRootLinux(
      `${install}groupadd -f docker
usermod -aG docker ${user}
systemctl enable --now docker
for i in $(seq 1 30); do [ -S ${sock} ] && break; sleep 1; done
command -v setfacl >/dev/null 2>&1 && setfacl -m u:${user}:rw ${sock} || true`,
      r.signal,
    );
    if (r.signal.aborted) throw new Cancelled();
    if (!res.ok) throw new Error(res.cancelled ? 'Cancelled at the password prompt' : `Docker Engine: ${lastLine(res.message)}`);
    r.step(1);
  }

  async stop(): Promise<void> {
    const res = await runAsRootLinux('systemctl stop docker.socket docker.service');
    if (!res.ok && !res.cancelled) throw new Error(`Docker Engine did not stop: ${lastLine(res.message)}`);
  }

  async reset(): Promise<void> {
    throw new Error('On Linux the engine is the system’s Docker Engine: DoCatz does not delete its data. Remove what you no longer need under Images, Volumes and Containers, or with docker system prune.');
  }

  async configure(): Promise<void> {
    // The computer's own CPUs, memory and disk: nothing to set.
  }

  async log(): Promise<string> {
    const r = await run('journalctl', ['-u', 'docker', '--no-pager', '-n', '300'], { timeout: 15_000 });
    return r.stdout.trim() || r.stderr.trim() || 'journalctl showed nothing (reading the system journal may need the adm group).';
  }

  dispose(): void {
    // Nothing of DoCatz's own runs for the engine.
  }
}
