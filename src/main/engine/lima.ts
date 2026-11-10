import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineConfig } from '@shared/types';
import { limaPackage, VERSIONS } from '../components';
import { fetchPinned } from '../download';
import { docatzDir, DOCATZ_HOME, socketPath } from '../paths';
import { lastLine, run } from '../proc';
import { machineArch } from '../machine';
import type { Backend, BackendStatus, StepReporter } from './backend';
import { MountEvents } from './mountevents';

/**
 * macOS: Lima (Apache-2.0) runs one Linux VM on Apple's Virtualization.framework (`vmType: vz`) with virtiofs mounts
 * of the home folder, Rosetta for amd64 images on Apple silicon, and dockerd inside (DoCatz TODO #1 / #5 / #8 / #10).
 * DoCatz keeps its own Lima — ~/.docatz/lima (limactl and its share folder) with LIMA_HOME=~/.docatz/vm — so it
 * never touches a Lima / Colima the user has. Lima forwards every port a container publishes to 127.0.0.1, and the
 * VM's /var/run/docker.sock to <vm>/sock/docker.sock, which ~/.docatz/run/docker.sock links to.
 */

const NAME = 'docatz';
const limaDir = () => docatzDir('lima');
const limaHome = () => docatzDir('vm');
/** Inside the VM: a time and a path per change; setting the file's own time raises the event there. */
const TOUCH_LOOP = 'while IFS= read -r t && IFS= read -r p; do touch -c -m -d "@$t" -- "$p" 2>/dev/null; done';
/**
 * Inside the VM: dockerd's `host-gateway` (`extra_hosts: …:host-gateway`, `--add-host …:host-gateway`, Laravel Sail's
 * default compose) is the VM's own docker0 (172.17.0.1) unless set, so such containers could not reach the Mac
 * (found by DevCatz with Postal, 2026-11-10). It becomes host.lima.internal's address from /etc/hosts; dockerd restarts
 * only when daemon.json changed (once per VM), and prints `changed` then.
 */
const HOST_GATEWAY = `set -e
ip=$(awk '$2 == "host.lima.internal" { print $1; exit }' /etc/hosts)
[ -n "$ip" ] || exit 0
mkdir -p /etc/docker
r=$(python3 - "$ip" <<'PY'
import json, os, sys
p, ip = '/etc/docker/daemon.json', sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
if d.get('host-gateway-ip') == ip:
    print('same')
else:
    d['host-gateway-ip'] = ip
    json.dump(d, open(p, 'w'), indent=2)
    print('changed')
PY
)
[ "$r" = changed ] || exit 0
systemctl restart docker
echo changed`;
const limactl = () => join(limaDir(), 'bin', 'limactl');
const vmDir = () => join(limaHome(), NAME);
const forwarded = () => join(vmDir(), 'sock', 'docker.sock');
const env = () => ({ ...process.env, LIMA_HOME: limaHome(), LIMA_INSTANCE: NAME });

interface LimaInstance {
  name: string;
  status: string;
  dir: string;
  cpus: number;
  memory: number;
  disk: number;
  vmType?: string;
  config?: { vmOpts?: { vz?: { rosetta?: { enabled?: boolean } } } };
}

/** The VM's definition. The image comes from Lima's own Ubuntu LTS template (pinned by digest there). */
function yaml(c: EngineConfig): string {
  const rosetta = machineArch() === 'arm64' && c.rosetta;
  return `# Written by DoCatz — changed by DoCatz's Engine settings; edits here are replaced.
minimumLimaVersion: 2.0.0
base:
- template:_images/ubuntu-lts
vmType: vz
cpus: ${c.cpus}
memory: ${c.memoryGiB}GiB
disk: ${c.diskGiB}GiB
mountType: virtiofs
mountInotify: false
mounts:
- location: "~"
  writable: true
- location: "/tmp/docatz"
  writable: true
vmOpts:
  vz:
    rosetta:
      enabled: ${rosetta}
      binfmt: ${rosetta}
containerd:
  system: false
  user: false
ssh:
  loadDotSSHPubKeys: false
provision:
- mode: system
  script: |
    #!/bin/sh
    sed -i 's/host.lima.internal.*/host.lima.internal host.docker.internal/' /etc/hosts
- mode: system
  script: |
    #!/bin/bash
    set -eux -o pipefail
    command -v docker >/dev/null 2>&1 && exit 0
    export DEBIAN_FRONTEND=noninteractive
    curl -fsSL https://get.docker.com | sh
- mode: yq
  path: /etc/systemd/system/docker.socket.d/override.conf
  format: ini
  expression: .Socket.SocketUser="{{.User}}"
probes:
- script: |
    #!/bin/bash
    set -eux -o pipefail
    if ! timeout 30s bash -c "until command -v docker >/dev/null 2>&1; do sleep 3; done"; then
      echo >&2 "docker is not installed yet"
      exit 1
    fi
    if ! timeout 30s bash -c "until pgrep dockerd; do sleep 3; done"; then
      echo >&2 "dockerd is not running"
      exit 1
    fi
  hint: See "/var/log/cloud-init-output.log" in the guest
hostResolver:
  hosts:
    host.docker.internal: host.lima.internal
portForwards:
- guestSocket: "/var/run/docker.sock"
  hostSocket: "{{.Dir}}/sock/docker.sock"
`;
}

export class LimaBackend implements Backend {
  readonly id = 'lima' as const;
  readonly steps = ['Download the VM manager (Lima)', 'Create the Linux VM', 'Start the VM and Docker', 'Connect to Docker'];

  private async limaInstalled(): Promise<boolean> {
    if (!existsSync(limactl())) return false;
    // The computer's own arch: an x86_64 limactl (the Intel build's, under Rosetta) refuses to run there, so it is replaced.
    const f = await run('/usr/bin/file', ['-b', limactl()], { timeout: 10_000 });
    if (f.code === 0 && !f.stdout.includes(machineArch() === 'arm64' ? 'arm64' : 'x86_64')) return false;
    const r = await run(limactl(), ['--version'], { env: env(), timeout: 15_000 });
    return r.code === 0 && r.stdout.includes(VERSIONS.lima);
  }

  private async instance(): Promise<LimaInstance | null> {
    if (!existsSync(limactl()) || !existsSync(vmDir())) return null;
    const r = await run(limactl(), ['list', '--json', NAME], { env: env(), timeout: 20_000 });
    if (r.code !== 0) return null;
    const line = r.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    return line ? (JSON.parse(line) as LimaInstance) : null;
  }

  async status(): Promise<BackendStatus> {
    const manager = `Lima ${VERSIONS.lima}`;
    if (process.platform !== 'darwin') return { status: 'unsupported', message: 'Lima runs the engine on macOS only', manager, dir: '', running: null };
    if (Number(process.getSystemVersion().split('.')[0]) < 13) return { status: 'unsupported', message: 'DoCatz needs macOS 13 or newer (Apple’s Virtualization framework)', manager, dir: '', running: null };
    const i = await this.instance().catch(() => null);
    if (!i) return { status: 'missing', message: 'No engine yet — Start sets it up (about 1 GB to download the first time).', manager, dir: vmDir(), running: null };
    const running = { cpus: i.cpus, memoryGiB: Math.round(i.memory / 1024 ** 3), diskGiB: Math.round(i.disk / 1024 ** 3), rosetta: i.config?.vmOpts?.vz?.rosetta?.enabled === true };
    const status = i.status === 'Running' ? 'running' : i.status === 'Stopped' ? 'stopped' : 'error';
    return { status, message: status === 'error' ? `The VM is ${i.status.toLowerCase()} — see the engine log, or Reset` : '', manager, dir: i.dir, running };
  }

  async start(config: EngineConfig, r: StepReporter): Promise<void> {
    r.step(0);
    if (!(await this.limaInstalled())) {
      const pkg = limaPackage();
      const file = await fetchPinned(pkg, (f, got, total) => r.detail(`Downloading Lima ${VERSIONS.lima}: ${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`, f), r.signal);
      rmSync(limaDir(), { recursive: true, force: true });
      mkdirSync(limaDir(), { recursive: true });
      const x = await run('/usr/bin/tar', ['-xzf', file, '-C', limaDir()], { timeout: 120_000 });
      if (x.code !== 0) throw new Error(`Lima could not be unpacked: ${lastLine(x.stderr)}`);
    }
    r.step(1);
    // Lima prints download progress on a terminal only: DoCatz watches its download itself and shows MB and a bar
    // (user, 2026-11-10); Lima's own lines show only while nothing downloads.
    const watch = watchImageDownload((text, fraction) => r.detail(text, fraction));
    const line = (l: string) => {
      if (!watch.active()) r.detail(lastLine(l));
    };
    try {
      if (!(await this.instance())) {
        mkdirSync('/tmp/docatz', { recursive: true });
        const file = join(DOCATZ_HOME, 'docatz.yaml');
        writeFileSync(file, yaml(config));
        const c = await run(limactl(), ['create', `--name=${NAME}`, '--tty=false', file], { env: env(), signal: r.signal, onLine: line });
        if (c.code !== 0) throw new Error(`The VM could not be created: ${lastLine(c.stderr) || `limactl exited ${c.code}`}`);
      }
      await this.lateEventsOff();
      r.step(2, 'The first start downloads Ubuntu and installs Docker inside — a few minutes.');
      const s = await run(limactl(), ['start', '--tty=false', '--timeout=15m', NAME], { env: env(), signal: r.signal, onLine: line });
      if (s.code !== 0) throw new Error(`The VM did not start: ${lastLine(s.stderr) || `limactl exited ${s.code}`}`);
    } finally {
      watch.stop();
    }
    r.step(3);
    await this.hostGatewayToMac();
    this.linkSocket();
  }

  /** host-gateway = the Mac (HOST_GATEWAY); new VMs and ones made before this get it on start. A failure only warns. */
  private async hostGatewayToMac(): Promise<void> {
    const r = await run(limactl(), ['shell', '--workdir=/', NAME, 'sudo', 'sh', '-c', HOST_GATEWAY], { env: env(), timeout: 90_000 });
    if (r.code !== 0) console.warn('host-gateway:', lastLine(r.stderr));
  }

  /** A VM made before DoCatz raised file events itself: Lima's own come 7 to 16 s late and watch the whole home folder. */
  private async lateEventsOff(): Promise<void> {
    if (!/^mountInotify:\s*true/m.test(readFileSync(join(vmDir(), 'lima.yaml'), 'utf8'))) return;
    const r = await run(limactl(), ['edit', '--tty=false', '--set=.mountInotify = false', NAME], { env: env(), timeout: 60_000 });
    if (r.code !== 0) console.warn('mountInotify:', lastLine(r.stderr));
  }

  private events = new MountEvents(
    (onExit) => {
      const sh = spawn(limactl(), ['shell', '--workdir=/', NAME, 'sudo', 'sh', '-c', TOUCH_LOOP], { env: env(), stdio: ['pipe', 'ignore', 'ignore'] });
      sh.on('exit', onExit);
      sh.on('error', onExit);
      sh.stdin.on('error', () => undefined);
      return { write: (text) => void sh.stdin.write(text), stop: () => void sh.kill() };
    },
    () => [homedir(), '/tmp/docatz'],
  );

  watchMounts(folders: string[]): void {
    this.events.sync(folders);
  }

  /** ~/.docatz/run/docker.sock → the socket Lima forwards (a short, stable path for the context and the CLIs). */
  private linkSocket(): void {
    const link = socketPath();
    const st = lstatSync(link, { throwIfNoEntry: false });
    if (st) {
      if (st.isSymbolicLink() && readlinkSync(link) === forwarded()) return;
      unlinkSync(link);
    }
    symlinkSync(forwarded(), link);
  }

  async stop(): Promise<void> {
    const r = await run(limactl(), ['stop', NAME], { env: env(), timeout: 180_000 });
    if (r.code !== 0) {
      // A VM that does not stop in time: force it (the disk is fine, running containers are killed).
      const f = await run(limactl(), ['stop', '--force', NAME], { env: env(), timeout: 60_000 });
      if (f.code !== 0) throw new Error(`The VM did not stop: ${lastLine(f.stderr || r.stderr)}`);
    }
  }

  async reset(): Promise<void> {
    if (existsSync(limactl())) await run(limactl(), ['delete', '--force', NAME], { env: env(), timeout: 180_000 });
    rmSync(vmDir(), { recursive: true, force: true });
    rmSync(socketPath(), { force: true });
  }

  async trim(): Promise<void> {
    await run(limactl(), ['shell', NAME, 'sudo', 'fstrim', '-a'], { env: env(), timeout: 120_000 });
  }

  async configure(c: EngineConfig): Promise<void> {
    if (!(await this.instance())) {
      writeFileSync(join(DOCATZ_HOME, 'docatz.yaml'), yaml(c));
      return;
    }
    const rosetta = machineArch() === 'arm64' && c.rosetta;
    const expr = `.cpus = ${c.cpus} | .memory = "${c.memoryGiB}GiB" | .disk = "${c.diskGiB}GiB" | .vmOpts.vz.rosetta.enabled = ${rosetta} | .vmOpts.vz.rosetta.binfmt = ${rosetta}`;
    const r = await run(limactl(), ['edit', '--tty=false', `--set=${expr}`, NAME], { env: env(), timeout: 60_000 });
    if (r.code !== 0) throw new Error(`The engine settings could not be changed: ${lastLine(r.stderr)}`);
  }

  async log(): Promise<string> {
    const parts: string[] = [];
    for (const f of ['ha.stderr.log', 'ha.stdout.log', 'serial.log']) {
      const p = join(vmDir(), f);
      if (existsSync(p)) parts.push(`==> ${f} <==\n${readFileSync(p, 'utf8').split('\n').slice(-200).join('\n')}`);
    }
    return parts.join('\n\n') || 'No engine log yet.';
  }

  dispose(): void {
    // Lima's host agent runs on its own: the engine keeps running when DoCatz quits. Only the events stop with DoCatz.
    this.events.stop();
  }
}

/**
 * Lima's image download, watched from outside (Lima shows its progress bar on a terminal only): its cache keeps each
 * download in ~/Library/Caches/lima/download/by-url-sha256/<hash>/ as `data.tmp.*` while it comes, with the `url`
 * beside it; the full size is the server's Content-Length. Reports "Downloading Ubuntu: 312 of 945 MB" once a second.
 */
function watchImageDownload(report: (text: string, fraction?: number) => void): { active: () => boolean; stop: () => void } {
  const root = join(process.env.LIMA_CACHE_HOME || join(homedir(), 'Library', 'Caches', 'lima'), 'download', 'by-url-sha256');
  const sizes = new Map<string, number | null>();
  let busy = false;
  let active = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let found: { dir: string; got: number } | null = null;
      for (const d of existsSync(root) ? readdirSync(root) : []) {
        const dir = join(root, d);
        const tmp = readdirSync(dir).find((f) => f.startsWith('data.tmp'));
        if (tmp) found = { dir, got: statSync(join(dir, tmp)).size };
      }
      active = !!found;
      if (!found) return;
      const url = readFileSync(join(found.dir, 'url'), 'utf8').trim();
      if (!sizes.has(url)) {
        sizes.set(url, null);
        const res = await fetch(url, { method: 'HEAD' }).catch(() => null);
        sizes.set(url, Number(res?.headers.get('content-length')) || null);
      }
      const total = sizes.get(url);
      const name = /ubuntu/i.test(url) ? 'Ubuntu' : (url.split('/').pop() ?? 'the image');
      const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
      report(total ? `Downloading ${name}: ${mb(found.got)} of ${mb(total)}` : `Downloading ${name}: ${mb(found.got)}`, total ? Math.min(1, found.got / total) : undefined);
    } catch {
      /* the file moved on: next tick */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  return { active: () => active, stop: () => clearInterval(timer) };
}
