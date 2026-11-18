import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { K8sState, K8sWorkloads } from '@shared/types';
import type { Naming } from './domains';
import { cliInstalled, dockerBin } from './cli';
import { KUBECTL_VERSION, kubectlPackage } from './components';
import { fetchPinned } from './download';
import { isWin } from './platform';
import { docatzDir, dockerHost, exe } from './paths';
import { lastLine, run } from './proc';

/**
 * Kubernetes (TODO #28): one local k3s cluster, off by default, as ONE container on DoCatz's own engine — so it is the
 * same on Standard, Lite, WSL 2 and the system's Docker, and no guest changes. k3s runs with `--docker` (its built-in
 * cri-dockerd): pods are containers of the same dockerd, so an image from `docker build` runs in the cluster at once,
 * no registry and no import (tried 2026-11-18: `kubectl run --image-pull-policy=Never` of a just-built image).
 *
 * Its container: privileged, the host's cgroup and pid namespaces, the Docker socket, and its data + kubelet folders
 * under /var/lib/docatz/k3s shared back to the host (kubelet's pod mounts must be real paths for dockerd). On its own
 * network `docatz-k8s`, never the host's: a run on the host network left kube-proxy / CNI rules in the VM that took
 * ports from Docker (found the same day). The API is published on 127.0.0.1:6443.
 *
 * Reads go through `docker exec docatz-k8s kubectl … -o json`, so the window needs no kubectl on the computer.
 */

export const K8S_NAME = 'docatz-k8s';
export const K8S_VERSION = 'v1.37.2-k3s1';
const IMAGE = `rancher/k3s:${K8S_VERSION}`;
const NET = 'docatz-k8s';
const DATA = '/var/lib/docatz/k3s';
const API_PORT = Number(process.env.DOCATZ_K8S_PORT) || 6443;
export const K8S_LABEL = 'com.mrcatz.docatz.k8s';
const kubeconfigFile = () => join(docatzDir('kube'), 'config');
/** LoadBalancer Services on the computer: one small forwarder container (the router's image) publishing their ports. */
const LB_NAME = 'docatz-k8s-lb';
/** On the forwarder: `<name>.<namespace>.k8s=<port>;…` — the proxy (domains.ts) gives each its name address. */
export const K8S_HOSTS_LABEL = 'com.mrcatz.docatz.k8s.hosts';
const dnsLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'x';
/** A Service's name before .docatz.<tld>. */
export const k8sHostName = (name: string, namespace: string): string => `${dnsLabel(name)}.${dnsLabel(namespace)}.k8s`;
/** Of a Service's ports, the one its name address opens: a web port when it has one, else its first. */
const WEB = [80, 443, 8080, 3000, 8000, 5000, 8443];
const webPort = (ports: number[]): number | undefined => WEB.find((w) => ports.includes(w)) ?? ports[0];
const LB_IMAGE = 'nginx:alpine';
const kubectlBin = () => exe('kubectl');
const kubectlMark = () => join(docatzDir('kube'), 'kubectl-version');

/** Can this computer still listen on 127.0.0.1:<port>? (Docker inside a VM cannot tell: it publishes there, and the forward to the computer fails quietly.) */
const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });

/** Is a cluster running on this engine? (the idle sleep asks: its pods are hidden from the containers list) */
export async function k8sRunning(): Promise<boolean> {
  if (!cliInstalled()) return false;
  const r = await run(dockerBin(), ['ps', '-q', '--filter', `name=^${K8S_NAME}$`], { env: { ...process.env, DOCKER_HOST: dockerHost() }, timeout: 15_000, cwd: '/' }).catch(() => null);
  return !!r && r.code === 0 && r.stdout.trim().length > 0;
}

const env = () => ({ ...process.env, DOCKER_HOST: dockerHost() });
const docker = (args: string[], timeout = 60_000) => run(dockerBin(), args, { env: env(), timeout, cwd: '/' });

async function inspect(): Promise<{ running: boolean; image: string } | null> {
  const r = await docker(['inspect', K8S_NAME, '--format', '{{.State.Running}} {{.Config.Image}}'], 15_000);
  if (r.code !== 0) return null;
  const [running, image] = r.stdout.trim().split(' ');
  return { running: running === 'true', image };
}

/**
 * The cluster's own kubectl. It must end by itself: a `docker exec` given up on here (timeout) leaves the process
 * running in the container, and a slow API then piles them up — 337 of them took all of the VM's memory once
 * (2026-11-18). So: kubectl's own request timeout, and `timeout` around it inside the container, both under ours.
 */
const kubectl = (args: string[], timeout = 30_000) => {
  const sec = Math.max(5, Math.floor(timeout / 1000) - 5);
  return docker(['exec', K8S_NAME, 'timeout', '-s', 'KILL', String(sec), 'kubectl', `--request-timeout=${Math.max(3, sec - 2)}s`, ...args], timeout);
};

/** Pods are containers of dockerd: when the cluster stops they go too, with the mounts kubelet left on the host. */
async function sweep(): Promise<void> {
  await docker(['rm', '-f', LB_NAME], 60_000);
  const ids = (await docker(['ps', '-aq', '--filter', 'label=io.kubernetes.pod.namespace'], 30_000)).stdout.split('\n').filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) await docker(['rm', '-f', ...ids.slice(i, i + 50)], 120_000);
  // The host's mount namespace, from a helper: kubelet's volume mounts under DATA would keep the folder busy.
  await docker(
    ['run', '--rm', '--privileged', '--pid=host', '--label', 'com.mrcatz.docatz.helper=1', '--entrypoint', 'nsenter', IMAGE, '-t', '1', '-m', '--', 'sh', '-c', `grep " ${DATA}/kubelet" /proc/self/mounts | cut -d" " -f2 | sort -r | xargs -r -n1 umount -l; true`],
    60_000,
  ).catch(() => undefined);
}

/**
 * Removes the cluster's container: stopped first, then removed, tried again a few times — with the host's pid namespace
 * a first `rm -f` can fail ("PID … is zombie and can not be killed") and work a moment later.
 */
async function removeContainer(): Promise<void> {
  await docker(['stop', '-t', '20', K8S_NAME], 120_000);
  for (let i = 0; i < 6; i++) {
    await docker(['rm', '-f', K8S_NAME], 60_000);
    if (!(await inspect())) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('The cluster\'s container could not be removed — try again in a moment');
}

/** The host's mounts made shared, with the two folders the cluster shares back (see start()). */
async function shareMounts(): Promise<void> {
  const r = await docker(
    ['run', '--rm', '--privileged', '--pid=host', '--label', 'com.mrcatz.docatz.helper=1', '--entrypoint', 'nsenter', IMAGE, '-t', '1', '-m', '--', 'sh', '-c', `mkdir -p ${DATA} /var/log/pods && mount --make-rshared /`],
    60_000,
  );
  if (r.code !== 0) throw new Error(`The engine could not be prepared for the cluster: ${lastLine(r.stderr)}`);
}

export class K8s {
  private busy: K8sState['status'] | null = null;
  private detail = '';
  private error = '';
  private published: number[] = [];
  private publishError = '';
  /** Ports left out because something else had them: tried again once one is free. */
  private leftOut: number[] = [];
  /** How the proxy names things (index.ts: the helper's answer when it serves). */
  naming: () => Naming | null = () => null;
  private syncing = false;
  /** One read of the workloads at a time: a second asker gets the same answer. */
  private reading: Promise<K8sWorkloads> | null = null;
  /** Services already given `localhost` as their external address (once each). */
  private named = new Set<string>();
  onChange: () => void = () => undefined;

  /** What it was when last looked at while not running: shown while the engine sleeps, without waking it. */
  private idle: 'off' | 'stopped' = 'off';

  /** `asleep`: the engine sleeps (Lite, on-demand Docker) — a running cluster would have kept it awake, so nothing is asked. */
  async state(asleep = false): Promise<K8sState> {
    const base = { version: K8S_VERSION.replace('-k3s', '+k3s'), apiPort: API_PORT, kubeconfig: kubeconfigFile(), detail: this.detail, error: this.error, node: null as string | null, context: this.contextInUse(), kubectl: this.kubectlInstalled(), published: this.published, publishError: this.publishError, tld: this.naming()?.tld ?? 'localhost' };
    if (!cliInstalled()) return { ...base, status: 'off' };
    if (this.busy) return { ...base, status: this.busy };
    if (asleep) return { ...base, status: this.idle };
    const c = await inspect().catch(() => null);
    if (!c) return { ...base, status: (this.idle = 'off') };
    if (!c.running) return { ...base, status: (this.idle = 'stopped') };
    const n = await kubectl(['get', 'nodes', '--no-headers'], 10_000).catch(() => null);
    const ready = !!n && n.code === 0 && / Ready /.test(n.stdout);
    return { ...base, status: ready ? 'running' : 'starting', node: ready ? n.stdout.trim().split(/\s+/)[0] : null };
  }

  private set(busy: K8sState['status'] | null, detail = ''): void {
    this.busy = busy;
    this.detail = detail;
    this.onChange();
  }

  /** Creates (or starts) the cluster and waits for its node; writes its kubeconfig. */
  async start(): Promise<void> {
    if (this.busy) return;
    this.error = '';
    this.set('starting', 'Getting Kubernetes ready');
    try {
      const c = await inspect();
      if (c && c.image !== IMAGE) {
        // Another k3s version from an older DoCatz: the container is replaced, the cluster's data stays.
        await removeContainer();
        await sweep();
      }
      if (c && c.image === IMAGE) {
        if (!c.running) {
          await shareMounts();
          const s = await docker(['start', K8S_NAME], 120_000);
          if (s.code !== 0) throw new Error(lastLine(s.stderr));
        }
      } else {
        if ((await docker(['image', 'inspect', IMAGE], 20_000)).code !== 0) {
          this.set('starting', 'Downloading Kubernetes (k3s), about 80 MB');
          const p = await docker(['pull', IMAGE], 900_000);
          if (p.code !== 0) throw new Error(`Kubernetes could not be downloaded: ${lastLine(p.stderr)}`);
        }
        this.set('starting', 'Starting the cluster');
        await docker(['network', 'create', NET], 30_000);
        // kubelet's pod mounts must travel back to the host (rshared), which needs a shared mount there. A systemd
        // host has that; Lite's guest does not ("path … is mounted on / but it is not a shared mount"): made so here,
        // in the host's mount namespace, with the two folders the cluster shares.
        await shareMounts();
        // dockerd under systemd (Standard, WSL with systemd, Linux) drives cgroups through systemd, and kubelet must
        // do the same; Lite's guest has no systemd (cgroupfs), where k3s's own default is right.
        const systemd = (await docker(['info', '--format', '{{.CgroupDriver}}'], 20_000)).stdout.trim() === 'systemd';
        const r = await docker(
          [
            'run', '-d', '--name', K8S_NAME, '--label', `${K8S_LABEL}=1`, '--restart', 'unless-stopped', '--network', NET,
            '--privileged', '--cgroupns=host', '--pid=host',
            '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', '/var/lib/docker:/var/lib/docker', '-v', '/sys/fs/cgroup:/sys/fs/cgroup', '-v', '/lib/modules:/lib/modules:ro',
            ...(systemd ? ['-v', '/run/systemd:/run/systemd', '-v', '/var/run/dbus:/var/run/dbus'] : []),
            '-v', `${DATA}:${DATA}:rshared`, '-v', '/var/log/pods:/var/log/pods:rshared',
            '-p', `127.0.0.1:${API_PORT}:6443`,
            IMAGE, 'server', '--docker', '--disable=traefik,servicelb', '--tls-san', '127.0.0.1', '--tls-san', 'localhost',
            `--data-dir=${DATA}/rancher`, `--kubelet-arg=root-dir=${DATA}/kubelet`,
            // Inside a systemd .scope (dockerd's container) k3s hands kubelet --kubelet-cgroups=/k3s, and kubelet moves
            // k3s there — with the host's cgroup namespace that is the host's /k3s: the container's scope empties,
            // systemd removes it, and every `docker exec` into the cluster fails ("can't open cgroup …scope"), so the
            // node never showed Ready (Ubuntu 26.04 docker.io, Hyper-V VM, 2026-11-18). Empty = kubelet stays put.
            ...(systemd ? ['--kubelet-arg=cgroup-driver=systemd', '--kubelet-arg=kubelet-cgroups='] : []),
          ],
          180_000,
        );
        if (r.code !== 0) throw new Error(`The cluster did not start: ${r.stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/^Run 'docker run --help'/.test(l)).pop() ?? `docker exited ${r.code}`}`);
      }
      this.set('starting', 'Waiting for the node');
      for (let i = 0; ; i++) {
        const n = await kubectl(['get', 'nodes', '--no-headers'], 10_000).catch(() => null);
        if (n && n.code === 0 && / Ready /.test(n.stdout)) break;
        if (i >= 90) throw new Error(`The node did not get ready: ${lastLine((await docker(['logs', '--tail', '5', K8S_NAME], 15_000)).stderr) || 'see docker logs docatz-k8s'}`);
        if (!(await inspect())?.running) throw new Error(`The cluster stopped: ${lastLine((await docker(['logs', '--tail', '5', K8S_NAME], 15_000)).stderr)}`);
        await new Promise((res) => setTimeout(res, 2000));
      }
      await this.writeKubeconfig();
    } catch (e) {
      this.error = (e as Error).message;
      throw e;
    } finally {
      this.set(null);
    }
  }

  /**
   * The engine came up (a restart, the computer's, Lite waking): Docker starts the cluster again by itself (restart
   * policy), except where the host's mounts are not shared at boot (Lite's guest) — there its start fails with "not a
   * shared mount", and it is started here after sharing them. A cluster the user stopped stays stopped.
   */
  async resume(): Promise<void> {
    if (this.busy || !cliInstalled()) return;
    const r = await docker(['inspect', K8S_NAME, '--format', '{{.State.Running}}|{{.State.Error}}'], 15_000).catch(() => null);
    if (!r || r.code !== 0) return;
    const [running, error] = r.stdout.trim().split('|');
    if (running === 'true' || !/shared mount/i.test(error ?? '')) return;
    await shareMounts();
    await docker(['start', K8S_NAME], 120_000);
    this.onChange();
  }

  /** Stops the cluster: its container and every pod's containers; the cluster's data stays for the next start. */
  async stop(): Promise<void> {
    if (this.busy) return;
    this.error = '';
    this.set('stopping', 'Stopping the cluster');
    try {
      await docker(['stop', '-t', '20', K8S_NAME], 120_000);
      await sweep();
    } finally {
      this.set(null);
    }
  }

  /** Removes the cluster and everything in it (typed "delete" in the window). */
  async remove(confirm: string): Promise<void> {
    if (confirm.trim().toLowerCase() !== 'delete') throw new Error('Type delete to confirm');
    if (this.busy) return;
    this.set('stopping', 'Removing the cluster');
    try {
      await removeContainer();
      await sweep();
      await docker(['run', '--rm', '--privileged', '--label', 'com.mrcatz.docatz.helper=1', '-v', '/var/lib/docatz:/host', '--entrypoint', 'rm', IMAGE, '-rf', '/host/k3s'], 120_000).catch(() => undefined);
      await docker(['network', 'rm', NET], 30_000);
    } finally {
      this.set(null);
    }
  }

  /** The cluster's kubeconfig as ~/.docatz/kube/config: context, cluster and user all named `docatz`. */
  private async writeKubeconfig(): Promise<void> {
    const r = await docker(['exec', K8S_NAME, 'cat', '/etc/rancher/k3s/k3s.yaml'], 15_000);
    if (r.code !== 0) throw new Error(`The kubeconfig could not be read: ${lastLine(r.stderr)}`);
    const text = r.stdout.replace(/https:\/\/127\.0\.0\.1:6443/g, `https://127.0.0.1:${API_PORT}`).replace(/\bdefault\b/g, 'docatz');
    mkdirSync(docatzDir('kube'), { recursive: true });
    writeFileSync(kubeconfigFile(), text, { mode: 0o600 });
  }

  /** Is `docatz` the current context of the user's own ~/.kube/config? (read only; DoCatz never rewrites that file) */
  private contextInUse(): boolean {
    try {
      return /^current-context:\s*docatz\s*$/m.test(readFileSync(join(homedir(), '.kube', 'config'), 'utf8'));
    } catch {
      return false;
    }
  }

  /** Pods, deployments and services of every namespace, read with the cluster's own kubectl. */
  workloads(): Promise<K8sWorkloads> {
    this.reading ??= this.readWorkloads().finally(() => (this.reading = null));
    return this.reading;
  }

  private async readWorkloads(): Promise<K8sWorkloads> {
    const get = async <T>(kind: string): Promise<T[]> => {
      const r = await kubectl(['get', kind, '-A', '-o', 'json'], 30_000);
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || `kubectl get ${kind} failed`);
      return (JSON.parse(r.stdout) as { items: T[] }).items;
    };
    type Meta = { metadata: { name: string; namespace: string; creationTimestamp: string; labels?: Record<string, string>; ownerReferences?: { kind: string; name: string }[] } };
    type CState = Record<string, { reason?: string } | undefined>;
    const [pods, deps, svcs] = await Promise.all([
      get<Meta & { spec: { nodeName?: string; containers: { name: string; image: string; ports?: { containerPort: number }[] }[] }; status: { phase: string; podIP?: string; containerStatuses?: { name: string; ready: boolean; restartCount: number; state?: CState }[] } }>('pods'),
      get<Meta & { spec: { replicas?: number; selector?: { matchLabels?: Record<string, string> }; template?: { spec?: { containers?: { image: string }[] } } }; status: { readyReplicas?: number } }>('deployments'),
      get<Meta & { spec: { type: string; clusterIP?: string; selector?: Record<string, string>; ports?: { name?: string; port: number; targetPort?: number | string; nodePort?: number; protocol?: string }[] } }>('services'),
    ]);
    const stateOf = (st: CState | undefined) => {
      const [k, v] = Object.entries(st ?? {})[0] ?? [];
      return v?.reason ?? (k ? k[0].toUpperCase() + k.slice(1) : 'Unknown');
    };
    // A deployment's pods belong to its ReplicaSet `<deployment>-<hash>`.
    const depOf = (ns: string, rs: string) => deps.find((d) => d.metadata.namespace === ns && rs.startsWith(`${d.metadata.name}-`) && /^[a-z0-9]{6,10}$/.test(rs.slice(d.metadata.name.length + 1)))?.metadata.name ?? null;
    return {
      pods: pods.map((p) => {
        const cs = p.status.containerStatuses ?? [];
        const waiting = cs.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean);
        const owner = p.metadata.ownerReferences?.[0] ? { kind: p.metadata.ownerReferences[0].kind, name: p.metadata.ownerReferences[0].name } : null;
        return {
          namespace: p.metadata.namespace,
          name: p.metadata.name,
          status: waiting ?? p.status.phase,
          ready: `${cs.filter((c) => c.ready).length}/${p.spec.containers.length}`,
          restarts: cs.reduce((n, c) => n + c.restartCount, 0),
          image: p.spec.containers[0]?.image ?? '',
          ip: p.status.podIP ?? null,
          node: p.spec.nodeName ?? null,
          created: p.metadata.creationTimestamp,
          owner,
          deployment: owner?.kind === 'ReplicaSet' ? depOf(p.metadata.namespace, owner.name) : null,
          labels: p.metadata.labels ?? {},
          containers: p.spec.containers.map((c) => {
            const st = cs.find((x) => x.name === c.name);
            return { name: c.name, image: c.image, ready: st?.ready ?? false, restarts: st?.restartCount ?? 0, state: stateOf(st?.state), ports: (c.ports ?? []).map((x) => x.containerPort) };
          }),
        };
      }),
      deployments: deps.map((d) => ({
        namespace: d.metadata.namespace,
        name: d.metadata.name,
        ready: d.status.readyReplicas ?? 0,
        replicas: d.spec.replicas ?? 0,
        images: (d.spec.template?.spec?.containers ?? []).map((c) => c.image),
        selector: d.spec.selector?.matchLabels ?? {},
        created: d.metadata.creationTimestamp,
      })),
      services: svcs.map((s) => ({
        namespace: s.metadata.namespace,
        name: s.metadata.name,
        type: s.spec.type,
        clusterIP: s.spec.clusterIP ?? null,
        ports: (s.spec.ports ?? []).map((p) => ({ name: p.name ?? null, port: p.port, targetPort: String(p.targetPort ?? p.port), nodePort: p.nodePort ?? null, protocol: p.protocol ?? 'TCP' })),
        selector: s.spec.selector ?? {},
        created: s.metadata.creationTimestamp,
        url: this.urlOf(s.metadata.name, s.metadata.namespace, s.spec.type, (s.spec.ports ?? []).filter((p) => (p.protocol ?? 'TCP') === 'TCP').map((p) => p.port)),
      })),
    };
  }

  private urlOf(name: string, namespace: string, type: string, ports: number[]): string | null {
    const n = this.naming();
    const port = webPort(ports.filter((p) => this.published.includes(p)));
    if (!n || type !== 'LoadBalancer' || !port) return null;
    return `${n.https ? 'https' : 'http'}://${k8sHostName(name, namespace)}.docatz.${n.tld}${n.clean ? '' : `:${n.https ? n.httpsPort : n.httpPort}`}`;
  }

  async deletePod(namespace: string, name: string): Promise<void> {
    if (!/^[a-z0-9.-]{1,253}$/.test(namespace) || !/^[a-z0-9.-]{1,253}$/.test(name)) throw new Error('Not a pod name');
    const r = await kubectl(['delete', 'pod', '-n', namespace, name, '--wait=false'], 30_000);
    if (r.code !== 0) throw new Error(lastLine(r.stderr));
  }

  async podLogs(namespace: string, name: string): Promise<string> {
    if (!/^[a-z0-9.-]{1,253}$/.test(namespace) || !/^[a-z0-9.-]{1,253}$/.test(name)) throw new Error('Not a pod name');
    const r = await kubectl(['logs', '-n', namespace, name, '--all-containers', '--tail', '300'], 30_000);
    return r.stdout || lastLine(r.stderr) || 'No log lines yet.';
  }

  kubeconfigExists = (): boolean => existsSync(kubeconfigFile());

  private kubectlInstalled(): boolean {
    try {
      return existsSync(kubectlBin()) && readFileSync(kubectlMark(), 'utf8').trim() === KUBECTL_VERSION;
    } catch {
      return false;
    }
  }

  /** kubectl next to DoCatz's docker (~/.docatz/bin, on the PATH when the user turned that on in Engine). */
  async installKubectl(): Promise<void> {
    if (this.busy) return;
    this.set(this.busy, 'Downloading kubectl');
    const file = await fetchPinned(kubectlPackage(), (_f, got, total) => {
      this.detail = `Downloading kubectl: ${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`;
      this.onChange();
    }, new AbortController().signal);
    copyFileSync(file, `${kubectlBin()}.new`);
    renameSync(`${kubectlBin()}.new`, kubectlBin());
    if (!isWin) chmodSync(kubectlBin(), 0o755);
    mkdirSync(docatzDir('kube'), { recursive: true });
    writeFileSync(kubectlMark(), KUBECTL_VERSION);
    this.detail = '';
    this.onChange();
  }

  /**
   * LoadBalancer Services reach the computer: k3s's own load balancer is off (its host ports would only open inside the
   * cluster's container), so DoCatz keeps one forwarder container on the cluster's network that publishes each
   * LoadBalancer port on 127.0.0.1 and sends it to the Service's NodePort. Recreated when the set of ports changes; the
   * Service gets `localhost` as its external address. A port already taken on the computer is left out and named.
   */
  async syncPublished(): Promise<void> {
    if (this.syncing || this.busy || !(await k8sRunning())) return;
    this.syncing = true;
    try {
      const r = await kubectl(['get', 'services', '-A', '-o', 'json'], 20_000);
      if (r.code !== 0) return;
      type Svc = { metadata: { name: string; namespace: string }; spec: { type: string; ports?: { port: number; nodePort?: number; protocol?: string }[] }; status?: { loadBalancer?: { ingress?: unknown[] } } };
      const lbs = (JSON.parse(r.stdout) as { items: Svc[] }).items.filter((s) => s.spec.type === 'LoadBalancer');
      const want = new Map<number, number>();
      for (const s of lbs) for (const p of s.spec.ports ?? []) if (p.nodePort && (p.protocol ?? 'TCP') === 'TCP' && !want.has(p.port)) want.set(p.port, p.nodePort);
      // Each Service's name address goes to its web port (the first Service on a port has it).
      const hostsOf = (open: number[]) =>
        lbs
          .map((s) => [k8sHostName(s.metadata.name, s.metadata.namespace), webPort((s.spec.ports ?? []).filter((p) => (p.protocol ?? 'TCP') === 'TCP').map((p) => p.port).filter((p) => open.includes(p) && want.get(p) === s.spec.ports?.find((x) => x.port === p)?.nodePort))] as const)
          .filter((h): h is readonly [string, number] => h[1] !== undefined)
          .map(([h, p]) => `${h}=${p}`)
          .sort()
          .join(';');
      const sig = [...want].sort((a, b) => a[0] - b[0]).map(([p, n]) => `${p}:${n}`).join(',') + `|${hostsOf([...want.keys()])}`;
      // A port left out because it was taken is tried again once it is free.
      const freed = this.leftOut.some((p) => want.has(p)) && (await Promise.all(this.leftOut.filter((p) => want.has(p)).map(portFree))).some(Boolean);
      const have = (await docker(['inspect', LB_NAME, '--format', '{{index .Config.Labels "com.mrcatz.docatz.k8s.ports"}}|{{.State.Running}}'], 15_000)).stdout.trim();
      // No LoadBalancer and no forwarder: nothing to do (no remove / notify every 10 s).
      if ((have !== `${sig}|true` || freed) && (want.size || have)) {
        const mine = new Set(this.published);
        await docker(['rm', '-f', LB_NAME], 60_000);
        this.published = [];
        this.publishError = '';
        let ports = [...want];
        // A port something else on this computer listens on is left out and named (ours from before are not asked:
        // their forward may still be closing).
        const taken: number[] = [];
        for (const [p] of ports) if (!mine.has(p) && !(await portFree(p))) taken.push(p);
        if (taken.length) {
          ports = ports.filter(([p]) => !taken.includes(p));
          this.publishError = `Port ${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already in use on this computer, so ${taken.length === 1 ? 'that Service is' : 'those Services are'} not opened on it.`;
        }
        // A port taken on the computer fails the whole run: it is dropped and the rest tried again (at most 5 times).
        for (let i = 0; ports.length && i < 5; i++) {
          const conf = `events{} stream{ ${ports.map(([p, n]) => `server{ listen ${p}; proxy_pass ${K8S_NAME}:${n}; }`).join(' ')} }`;
          const run = await docker(
            ['run', '-d', '--name', LB_NAME, '--label', `${K8S_LABEL}=1`, '--label', `com.mrcatz.docatz.k8s.ports=${sig}`, '--label', `${K8S_HOSTS_LABEL}=${hostsOf(ports.map(([p]) => p))}`, '--restart', 'unless-stopped', '--network', NET, ...ports.flatMap(([p]) => ['-p', `127.0.0.1:${p}:${p}`]), LB_IMAGE, 'sh', '-c', `echo '${conf}' > /etc/nginx/nginx.conf && exec nginx -g 'daemon off;'`],
            120_000,
          );
          if (run.code === 0) {
            this.published = ports.map(([p]) => p).sort((a, b) => a - b);
            break;
          }
          await docker(['rm', '-f', LB_NAME], 60_000);
          const taken = Number(/(?:port|:)(\d{1,5})(?: failed|: bind| is already)/i.exec(run.stderr)?.[1] ?? /0\.0\.0\.0:(\d+)|127\.0\.0\.1:(\d+)/.exec(run.stderr)?.slice(1).find(Boolean));
          if (!taken || !ports.some(([p]) => p === taken)) {
            this.publishError = lastLine(run.stderr);
            break;
          }
          this.publishError = `Port ${taken} is already in use, so that Service is not opened on it.`;
          ports = ports.filter(([p]) => p !== taken);
        }
        this.leftOut = [...want.keys()].filter((p) => !this.published.includes(p));
        this.onChange();
      }
      // `localhost` as the external address (a hostname: kube-proxy makes no rules for it), so kubectl shows it.
      for (const s of lbs) {
        const key = `${s.metadata.namespace}/${s.metadata.name}`;
        if (s.status?.loadBalancer?.ingress?.length || this.named.has(key)) continue;
        this.named.add(key);
        await kubectl(['patch', 'service', '-n', s.metadata.namespace, s.metadata.name, '--subresource=status', '--type=merge', '-p', '{"status":{"loadBalancer":{"ingress":[{"hostname":"localhost"}]}}}'], 20_000).catch(() => undefined);
      }
    } finally {
      this.syncing = false;
    }
  }
}
