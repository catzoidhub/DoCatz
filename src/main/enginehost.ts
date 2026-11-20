import { watchFile } from 'node:fs';
import type { DcContainer, DcDomains, EngineState } from '@shared/types';
import { setBridgeDialcatzMocks, writeBridge } from './bridge';
import { updateDatabases } from './dbservices';
import * as ops from './docker/ops';
import { dialcatzBridgeFile, dialcatzMocks, mockRoutes } from './dialcatz';
import { Domains } from './domains';
import { Engine } from './engine';
import { learnProject } from './frameworks';
import { k8sRunning } from './k8s';

/**
 * What keeps the engine and its network side running (#107): the engine (VM / dockerd), the domains proxy and the
 * database ports (domains.ts, docker/router.ts), the file events into the VM, the containers' list kept fresh by the
 * engine's events, and bridge.json for the other Catzoid apps. It runs either inside DoCatz (today's behaviour) or in
 * the engine helper (src/helper), which outlives the window and DoCatz itself; the app then talks to it over the
 * control channel (helperchannel.ts) and keeps only the window, the tray and its own list for showing.
 */
/** What EngineHost needs of an engine: the Engine itself, or RemoteEngine (helperctl.ts) answered by the helper. */
export type EngineLike = Pick<Engine, 'up' | 'state' | 'start' | 'stop' | 'restart' | 'reset' | 'configure' | 'cancel' | 'adopt' | 'setupWsl' | 'log' | 'setContext' | 'installCli' | 'setPath' | 'dispose'> & {
  onChange: (s: EngineState) => void;
  onUp: () => void;
  backend: { watchMounts?: (folders: string[]) => void; trim?: () => Promise<void>; sleeping?: () => Promise<boolean>; sleep?: (maxConnections?: number) => Promise<void>; canSleep?: () => boolean };
};

export class EngineHost {
  readonly engine: EngineLike;
  readonly domains = new Domains();
  /**
   * Serving: this process runs the proxy, the database ports, the file events, the engine's events and bridge.json
   * (DoCatz without the helper, or the helper itself). Not serving: DoCatz with the helper running — it only lists
   * containers for its window, refreshed when the helper says the list changed.
   */
  readonly serving: boolean;
  containers: DcContainer[] = [];
  /** The list changed (after every refresh). */
  onList: (containers: DcContainer[]) => void = () => undefined;
  onEngine: (s: EngineState) => void = () => undefined;
  onDomains: (d: DcDomains) => void = () => undefined;
  /** The compose projects with their files (for framework marks); the app passes its own reader. */
  projects: () => Promise<{ name: string; files: string[] }[]> = async () => [];

  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private stopEvents: (() => void) | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  /** Idle sleep (Lite, #106): when the engine last had something to do, and since when nothing runs. */
  private lastActivity = Date.now();
  private idleSince: number | null = null;
  static IDLE_SLEEP_MS = Number(process.env.DOCATZ_IDLE_SLEEP_MS) || 15 * 60_000;

  constructor(opts: { engine?: EngineLike; serving?: boolean } = {}) {
    this.engine = opts.engine ?? new Engine();
    this.serving = opts.serving ?? true;
    ops.setDomainNameLookup(this.domains.nameOf);
    this.engine.onChange = (s) => this.onEngine(s);
    this.engine.onUp = () => {
      if (this.serving) void this.watchEvents();
      void this.refresh();
    };
    this.domains.onChange = () => void this.refresh();
    this.domains.onState = (d) => this.onDomains(d);
    // A mock started or stopped in DialCatz: its name follows within a few seconds, not at the next 30 s refresh.
    if (this.serving) watchFile(dialcatzBridgeFile(), { interval: 2000, persistent: false }, (cur, prev) => cur.mtimeMs !== prev.mtimeMs && void this.refresh());
  }

  /** The proxy, then the engine's list when it is already up (found running, or started with DoCatz). */
  async start(): Promise<void> {
    if (this.serving) await this.domains.start().catch((e) => console.warn('DoCatz proxy:', (e as Error).message));
    if (await this.engine.up()) this.engine.onUp();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        this.containers = (await this.engine.up()) ? await ops.listContainers(this.domains.urlFor) : [];
      } catch {
        this.containers = [];
      }
      const containers = this.containers;
      // Frameworks of services built from source (their marks): learnt per project in the background, by whichever
      // process lists — with the helper on, DoCatz's own list reads its own cache (it used to stay empty there).
      if (containers.some((c) => c.project && !c.framework))
        void this.projects()
          .then((list) => list.forEach((p) => void learnProject(p.name, p.files, () => void this.refresh())))
          .catch(() => undefined);
      if (!this.serving) return this.onList(containers);
      const up = await this.engine.up(); // false while asleep, without touching the socket
      // Asleep: nothing below may touch the socket — the routes' and k8s' reads woke Docker again within a second of
      // the idle stop (Linux on-demand, Hyper-V VM, 2026-11-18). Asleep counts as running for the other apps: their
      // first use of the socket wakes it.
      // DialCatz's mocks of DoCatz projects: their names through the proxy, and back in bridge.json (no Docker involved).
      const n = this.domains.naming();
      setBridgeDialcatzMocks(dialcatzMocks(n).map((m) => ({ workspaceId: m.workspaceId, collectionId: m.collectionId, domain: m.domain, url: m.url })));
      if (!up && (await this.engine.backend.sleeping?.().catch(() => false))) {
        // Nothing runs while it sleeps; DialCatz's mocks still get their names (no container, no socket).
        await this.domains.setRoutes([], [], mockRoutes()).catch(() => undefined);
        writeBridge([], 'running', { httpsPort: this.domains.httpsPort, httpPort: this.domains.httpPort }, true);
        return this.onList(containers);
      }
      // Woken by someone using Docker (the VM was asleep): its events are followed again.
      if (!this.stopEvents && up) void this.watchEvents();
      if (this.engine.backend.watchMounts) this.engine.backend.watchMounts(containers.length ? await ops.bindMounts().catch(() => []) : []);
      const streams = await updateDatabases(containers).catch((e) => (console.warn('databases:', (e as Error).message), []));
      const k8sHosts = await ops.k8sHosts().catch(() => []);
      await this.domains.setRoutes(containers, streams, [...k8sHosts, ...mockRoutes()]).catch((e) => console.warn('routes:', (e as Error).message));
      writeBridge(containers, containers.length || up ? 'running' : 'stopped', { httpsPort: this.domains.httpsPort, httpPort: this.domains.httpPort });
      this.onList(containers);
      // Last, so nothing of this refresh reaches the socket once the engine is put to sleep.
      void this.maybeSleep(containers);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  /** Engine events that change what the window lists (containers, images, volumes, networks). */
  private static LIST_EVENTS = new Set([
    ...['create', 'start', 'stop', 'die', 'destroy', 'kill', 'pause', 'unpause', 'restart', 'rename', 'update', 'oom', 'health_status'].map((a) => `container:${a}`),
    ...['pull', 'delete', 'tag', 'untag', 'import', 'load', 'prune'].map((a) => `image:${a}`),
    ...['create', 'destroy', 'prune'].map((a) => `volume:${a}`),
    ...['create', 'destroy', 'connect', 'disconnect', 'prune'].map((a) => `network:${a}`),
  ]);

  async watchEvents(): Promise<void> {
    if (this.stopEvents) return;
    try {
      this.stopEvents = await ops.watchEvents(
        (type, action) => {
          this.lastActivity = Date.now();
          // Only what changes a list: healthchecks and DoCatz's own reads run `exec` many times a minute.
          if (!EngineHost.LIST_EVENTS.has(`${type}:${action.split(':')[0].trim()}`)) return;
          if (this.eventTimer) return;
          this.eventTimer = setTimeout(() => {
            this.eventTimer = null;
            void this.refresh();
          }, 300);
        },
        () => {
          this.stopEvents = null;
          void this.refresh();
          // The engine went away (stopped, restarted): try again while it comes back.
          setTimeout(() => void this.engine.up().then((up) => (up ? this.watchEvents() : undefined)), 3000);
        },
      );
    } catch {
      this.stopEvents = null;
    }
  }

  /**
   * Lite's idle sleep (#106): nothing but DoCatz's own router running and no engine events for 15 minutes → the VM
   * sleeps (docatz-vmm `sleep`), its memory goes back to the Mac, and the first use of the Docker socket wakes it. Only
   * the serving process decides, and nothing here touches the socket while it sleeps (Engine.up checks first).
   */
  private async maybeSleep(containers: DcContainer[]): Promise<void> {
    const b = this.engine.backend;
    if (!this.serving || !b.sleep || (b.canSleep && !b.canSleep())) return;
    // The list hides DoCatz's own router, so an empty list can still be a running engine: asked, not guessed.
    // First of all: nothing below may touch the socket of a sleeping engine (up() does not wake it).
    if (!(await this.engine.up())) return; // stopped, starting or already asleep
    const busy = containers.some((c) => c.state === 'running' && c.name !== 'docatz-router');
    // A running cluster (TODO #28) is in use too: its pods are hidden from this list.
    if (busy || (await k8sRunning())) {
      this.idleSince = null;
      return;
    }
    this.idleSince ??= Date.now();
    if (Date.now() - Math.max(this.idleSince, this.lastActivity) < EngineHost.IDLE_SLEEP_MS) return;
    this.idleSince = null;
    // DoCatz's own events stream goes first: ending with the sleep, it refreshed at once, and a ping while systemd still
    // said "active" went to the socket and started Docker again within 0.2 s (Linux on-demand, Hyper-V VM, 2026-11-18).
    // It comes back once the engine answers again (refresh), or right away when the sleep is refused.
    const watching = !!this.stopEvents;
    this.stopWatching();
    if (watching) await new Promise((r) => setTimeout(r, 300));
    // "Nobody using it": docatz-vmm refuses while other Docker connections are open (a quiet `docker build`, a CLI
    // session) — then the 15 minutes start again.
    try {
      await b.sleep(0);
    } catch (e) {
      if (!/in use/i.test((e as Error).message)) console.warn('idle sleep:', (e as Error).message);
      if (watching) void this.watchEvents();
      return;
    }
    this.onEngine(await this.engine.state());
    void this.refresh();
  }

  stopWatching(): void {
    this.stopEvents?.();
    this.stopEvents = null;
  }

  dispose(): void {
    this.stopWatching();
    this.domains.stop();
    this.engine.dispose();
  }
}
