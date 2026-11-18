import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { K8sState, K8sWorkloads } from '@shared/types';
import { cliInstalled, dockerBin } from './cli';
import { docatzDir, dockerHost } from './paths';
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

const env = () => ({ ...process.env, DOCKER_HOST: dockerHost() });
const docker = (args: string[], timeout = 60_000) => run(dockerBin(), args, { env: env(), timeout, cwd: '/' });

async function inspect(): Promise<{ running: boolean; image: string } | null> {
  const r = await docker(['inspect', K8S_NAME, '--format', '{{.State.Running}} {{.Config.Image}}'], 15_000);
  if (r.code !== 0) return null;
  const [running, image] = r.stdout.trim().split(' ');
  return { running: running === 'true', image };
}

const kubectl = (args: string[], timeout = 30_000) => docker(['exec', K8S_NAME, 'kubectl', ...args], timeout);

/** Pods are containers of dockerd: when the cluster stops they go too, with the mounts kubelet left on the host. */
async function sweep(): Promise<void> {
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

export class K8s {
  private busy: K8sState['status'] | null = null;
  private detail = '';
  private error = '';
  onChange: () => void = () => undefined;

  async state(): Promise<K8sState> {
    const base = { version: K8S_VERSION.replace('-k3s', '+k3s'), apiPort: API_PORT, kubeconfig: kubeconfigFile(), detail: this.detail, error: this.error, node: null as string | null, context: this.contextInUse() };
    if (!cliInstalled()) return { ...base, status: 'off' };
    if (this.busy) return { ...base, status: this.busy };
    const c = await inspect().catch(() => null);
    if (!c) return { ...base, status: 'off' };
    if (!c.running) return { ...base, status: 'stopped' };
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
            ...(systemd ? ['--kubelet-arg=cgroup-driver=systemd'] : []),
          ],
          180_000,
        );
        if (r.code !== 0) throw new Error(`The cluster did not start: ${lastLine(r.stderr)}`);
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
  async workloads(): Promise<K8sWorkloads> {
    const get = async <T>(kind: string): Promise<T[]> => {
      const r = await kubectl(['get', kind, '-A', '-o', 'json'], 30_000);
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || `kubectl get ${kind} failed`);
      return (JSON.parse(r.stdout) as { items: T[] }).items;
    };
    type Meta = { metadata: { name: string; namespace: string; creationTimestamp: string } };
    const [pods, deps, svcs] = await Promise.all([
      get<Meta & { spec: { containers: { image: string }[] }; status: { phase: string; podIP?: string; containerStatuses?: { ready: boolean; restartCount: number; state?: Record<string, { reason?: string }> }[] } }>('pods'),
      get<Meta & { spec: { replicas?: number }; status: { readyReplicas?: number } }>('deployments'),
      get<Meta & { spec: { type: string; clusterIP?: string; ports?: { port: number; nodePort?: number; protocol?: string }[] } }>('services'),
    ]);
    return {
      pods: pods.map((p) => {
        const cs = p.status.containerStatuses ?? [];
        const waiting = cs.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean);
        return {
          namespace: p.metadata.namespace,
          name: p.metadata.name,
          status: waiting ?? p.status.phase,
          ready: `${cs.filter((c) => c.ready).length}/${p.spec.containers.length}`,
          restarts: cs.reduce((n, c) => n + c.restartCount, 0),
          image: p.spec.containers[0]?.image ?? '',
          ip: p.status.podIP ?? null,
          created: p.metadata.creationTimestamp,
        };
      }),
      deployments: deps.map((d) => ({ namespace: d.metadata.namespace, name: d.metadata.name, ready: d.status.readyReplicas ?? 0, replicas: d.spec.replicas ?? 0, created: d.metadata.creationTimestamp })),
      services: svcs.map((s) => ({
        namespace: s.metadata.namespace,
        name: s.metadata.name,
        type: s.spec.type,
        clusterIP: s.spec.clusterIP ?? null,
        ports: (s.spec.ports ?? []).map((p) => ({ port: p.port, nodePort: p.nodePort ?? null, protocol: p.protocol ?? 'TCP' })),
        created: s.metadata.creationTimestamp,
      })),
    };
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
}
