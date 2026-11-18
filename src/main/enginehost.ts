import type { DcContainer, DcDomains, EngineState } from '@shared/types';
import { writeBridge } from './bridge';
import { updateDatabases } from './dbservices';
import * as ops from './docker/ops';
import { Domains } from './domains';
import { Engine } from './engine';
import { learnProject } from './frameworks';

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
  backend: { watchMounts?: (folders: string[]) => void; trim?: () => Promise<void> };
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
      if (!this.serving) return this.onList(containers);
      if (this.engine.backend.watchMounts) this.engine.backend.watchMounts(containers.length ? await ops.bindMounts().catch(() => []) : []);
      const streams = await updateDatabases(containers).catch((e) => (console.warn('databases:', (e as Error).message), []));
      await this.domains.setRoutes(containers, streams).catch((e) => console.warn('routes:', (e as Error).message));
      // Frameworks of services built from source (their marks): learnt per project in the background.
      if (containers.some((c) => c.project && !c.framework))
        void this.projects()
          .then((list) => list.forEach((p) => void learnProject(p.name, p.files, () => void this.refresh())))
          .catch(() => undefined);
      writeBridge(containers, containers.length || (await this.engine.up()) ? 'running' : 'stopped', { httpsPort: this.domains.httpsPort, httpPort: this.domains.httpPort });
      this.onList(containers);
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
