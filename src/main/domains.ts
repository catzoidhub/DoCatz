import { X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttp, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps, request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import forge from 'node-forge';
import type { DcContainer, DcDomains, DcDomainsPatch, TaskProgress } from '@shared/types';
import { findCatzoidApp } from './companion';
import { DNS_HOST, DNS_PORT, DnsServer } from './dns';
import { Router, ROUTER_PORT, type RouterTarget } from './docker/router';
import { isWeb, NOT_WEB } from './webports';
import { isWin } from './platform';
import { lastLine, run } from './proc';
import { readShared, SHARED_DIR, writeShared, type SharedDomains } from './shared';
import { dataDir, store } from './store';
import { cancelled, forwardTarget, installForward, installResolver, resolverStatus, resolverZones, uninstallForward, uninstallResolver } from './system';

/**
 * Container domains (DoCatz TODO #9) on the default domain, HTTPS and names without a port shared with DevCatz (#61).
 *
 * - Every container that publishes a TCP port gets https://<service>.<project>.docatz.<tld> (compose) or
 *   https://<name>.docatz.<tld>; DoCatz's proxy on 127.0.0.1 / ::1 forwards it to the published port on localhost.
 * - Catzoid/shared.json `domains` (DevCatz's contract): the TLD, the local CA (`by` = the app that made it, `trusted`),
 *   names without a port (`on`, the proxy ports, `by`) and `usedBy`. DoCatz can set up each of them on its own — when
 *   DevCatz is not installed too — with the same steps and the same system pieces DevCatz uses (system.ts), so the two
 *   apps never install two of anything.
 * - With DevCatz installed, :443 points at DevCatz's proxy (its sites must keep working); DevCatz terminates TLS and
 *   hands docatz.<tld> / *.docatz.<tld> to DoCatz's HTTP port (from bridge.json `proxy.httpPort`, DevCatz 61ba5fb)
 *   with the Host unchanged and X-Forwarded-Proto set; DoCatz drops the :port once a probe through :443 comes back
 *   with its `x-docatz` mark (`cleanUrls.reachesDocatz`).
 */

const DEFAULT_HTTPS = 8743;
const DEFAULT_HTTP = 8780;
const ME = 'docatz';
const CA_NAME = 'Catzoid Local CA';
const HTTPS_KEY = 'domainsHttps';
const NAMES_KEY = 'domainNames';
const DEVCATZ_DATA = isWin ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DevCatz') : join(homedir(), 'Library', 'Application Support', 'DevCatz');
/** Private ports that usually serve the app (picked first when a container publishes several). */
const WEB_PORTS = [80, 8080, 3000, 8000, 5173, 4321, 5000, 4200, 8888, 4000, 9000, 443, 8443];
/** Ports that are never the app (Caddy / FrankenPHP's admin API, metrics, debuggers). */
const ADMIN_PORTS = [2019, 9003, 9229];
/** DoCatz's proxy marks its answers, so a probe through :443 can tell whether it reaches DoCatz. */
const MARK = 'x-docatz';

interface Ca {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
  pem: string;
  files: { cert: string; key: string; by: string };
}

/** DevCatz's own config (before it publishes shared.json `domains`): its TLD and proxy ports. */
function devcatzConfig(): { tld?: string; httpsPort?: number; httpPort?: number } {
  try {
    return (JSON.parse(readFileSync(join(DEVCATZ_DATA, 'config.json'), 'utf8')) as { settings?: { tld?: string; httpsPort?: number; httpPort?: number } }).settings ?? {};
  } catch {
    return {};
  }
}

const label = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'x';
const shared = (): SharedDomains => readShared().domains ?? {};

export class Domains {
  private ca: Ca | null = null;
  private contexts = new Map<string, SecureContext>();
  /** host → where it goes: the router (the container's own IP inside the VM) or a published port on localhost. */
  private routes = new Map<string, { router: boolean; port: number }>();
  private router = new Router();
  private servers: Server[] = [];
  private dns = new DnsServer();
  private devcatz: string | null = null;
  private task: DcDomains['task'] = null;
  private taskClear: ReturnType<typeof setTimeout> | undefined;
  private probe: { at: number; reaches: boolean; resolves: boolean; frontDown?: boolean } | null = null;
  readonly httpsPort = Number(process.env.DOCATZ_HTTPS_PORT) || DEFAULT_HTTPS;
  readonly httpPort = Number(process.env.DOCATZ_HTTP_PORT) || DEFAULT_HTTP;
  /** URLs changed (TLD, HTTPS, forwarding): the list follows. */
  onChange: () => void = () => undefined;
  /** A setup step moved: the window shows it. */
  onState: (d: DcDomains) => void = () => undefined;

  tld(): string {
    return shared().tld || devcatzConfig().tld || 'localhost';
  }
  https(): boolean {
    return store.extra<boolean>(HTTPS_KEY) !== false;
  }

  async start(): Promise<void> {
    this.devcatz = await findCatzoidApp('DevCatz', 'devcatz', 'com.mrcatz.devcatz').catch(() => null);
    const d = shared();
    if (!(d.usedBy ?? []).includes(ME)) writeShared({ domains: { usedBy: [...(d.usedBy ?? []), ME] } });
    const handler = (req: IncomingMessage, res: ServerResponse) => this.forward(req, res);
    const upgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(req, socket, head);
    let https: { cert: string; key: string } | null = null;
    try {
      this.ensureCa();
      https = this.leaf('docatz.localhost');
    } catch (e) {
      console.warn('DoCatz proxy: HTTPS off —', (e as Error).message);
    }
    for (const host of ['127.0.0.1', '::1']) {
      const http = createHttp(handler);
      http.on('upgrade', upgrade);
      this.listen(http, this.httpPort, host);
      if (!https) continue;
      const s = createHttps({ SNICallback: (name, cb) => cb(null, this.context(name)), ...https }, handler);
      s.on('upgrade', upgrade);
      this.listen(s, this.httpsPort, host);
    }
    await this.startDns();
    // Whether :443 reaches DoCatz changes when DevCatz starts or quits (it is the front when installed): check every
    // 10 s, and when it changes the URLs follow at once.
    const probe = async () => {
      await this.standInCheck();
      const on = shared().cleanUrls?.on === true;
      const r = on ? await this.reachesDocatz() : 'no';
      const reaches = r === 'yes';
      const changed = this.probe?.reaches !== reaches || this.probe?.frontDown !== (r === 'down');
      this.probe = { at: Date.now(), reaches, frontDown: r === 'down', resolves: this.probe?.resolves ?? (await this.resolves()) };
      if (changed) this.onChange();
    };
    void probe();
    this.probeTimer = setInterval(() => void probe(), 10_000);
  }

  private probeTimer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- standing in for DevCatz's proxy

  /**
   * With DevCatz installed, :443 / :80 point at DevCatz's proxy, which only runs while DevCatz does. While DevCatz is
   * closed, DoCatz listens on those ports itself (its own names answer; DevCatz's get a page saying to open DevCatz),
   * and lets go of them as soon as DevCatz starts (checked every 2 s while standing in; DevCatz retries its bind).
   */
  /** The stand-in's listeners by host:port — only those that took their port (see standInCheck). */
  private standIn = new Map<string, Server>();
  private standInTimer: ReturnType<typeof setInterval> | null = null;

  private async devcatzRunning(): Promise<boolean> {
    if (isWin) return /DevCatz\.exe/i.test((await run('tasklist', ['/FI', 'IMAGENAME eq DevCatz.exe', '/NH'], { timeout: 10_000 })).stdout);
    return (await run('/usr/bin/pgrep', ['-f', 'DevCatz.app/Contents/MacOS/DevCatz'], { timeout: 10_000 })).code === 0;
  }

  private async standInCheck(): Promise<void> {
    const c = shared().cleanUrls;
    const wanted = !!c?.on && c.by === 'devcatz' && this.devcatz !== null && this.ca !== null && !(await this.devcatzRunning());
    // A port still held when DevCatz had only just quit (or by a DevCatz not seen as running, a development one) is
    // tried again at every check — it used to count as taken for good, and the names kept their :port until a restart.
    if (wanted && this.standIn.size < 4) this.startStandIn(c!.httpsPort, c!.httpPort);
    else if (!wanted && this.standIn.size) this.stopStandIn();
  }

  /** Listens on the ports not yet held (127.0.0.1 and ::1, HTTP and HTTPS); one that is taken drops out, for the next try. */
  private startStandIn(httpsPort: number, httpPort: number): void {
    const handler = (req: IncomingMessage, res: ServerResponse) => this.forward(req, res);
    const upgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(req, socket, head);
    const https = this.leaf('docatz.localhost');
    for (const host of ['127.0.0.1', '::1']) {
      for (const [tls, port] of [[false, httpPort], [true, httpsPort]] as const) {
        const key = `${host}:${port}`;
        if (this.standIn.has(key)) continue;
        const srv = tls ? createHttps({ SNICallback: (name, cb) => cb(null, this.context(name)), ...https }, handler) : createHttp(handler);
        srv.on('upgrade', upgrade);
        srv.on('error', (e: NodeJS.ErrnoException) => {
          console.warn(`DoCatz stand-in for DevCatz: ${key} — ${e.code ?? e.message}`);
          if (this.standIn.get(key) === srv) this.standIn.delete(key);
          srv.close();
        });
        srv.listen(port, host);
        this.standIn.set(key, srv);
      }
    }
    this.standInTimer ??= setInterval(() => void this.devcatzRunning().then((up) => up && this.stopStandIn()), 2000);
  }

  private stopStandIn(): void {
    if (this.standInTimer) clearInterval(this.standInTimer);
    this.standInTimer = null;
    for (const s of this.standIn.values()) s.close();
    this.standIn.clear();
    this.probe = null;
    this.onChange();
  }

  private listen(s: Server, port: number, host: string): void {
    s.on('error', (e: NodeJS.ErrnoException) => console.warn(`DoCatz proxy: ${host}:${port} — ${e.code === 'EADDRINUSE' ? 'the port is in use' : e.message}`));
    s.listen(port, host);
    this.servers.push(s);
  }

  /** Answers the resolver's zones when one is needed; a DNS DevCatz already runs on the same address does the same job. */
  private async startDns(): Promise<void> {
    const zones = resolverZones(this.tld());
    if (!zones.length) return void (await this.dns.stop());
    await this.dns.start(this.tld());
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.stopStandIn();
    for (const s of this.servers) s.close();
    this.servers = [];
    void this.dns.stop();
  }

  // ---------------------------------------------------------------- names and routes

  /** The container's host name: every container on a network (its own IP), or one that publishes a TCP port. */
  hostFor(c: Pick<DcContainer, 'name' | 'project' | 'service' | 'ports' | 'ip' | 'domainKey'>): string | null {
    if (!c.ip && !c.ports.some((p) => p.type === 'tcp' && p.public)) return null;
    const name = this.nameOf(c.domainKey) ?? (c.project && c.service ? `${label(c.service)}.${label(c.project)}` : label(c.name));
    return `${name}.docatz.${this.tld()}`;
  }

  // ---------------------------------------------------------------- custom names (the part before .docatz.<tld>)

  nameOf = (key: string): string | null => (store.extra<Record<string, string>>(NAMES_KEY) ?? {})[key] ?? null;

  /** A name of one or more labels (`shop`, `api.shop`); the suffix .docatz.<tld> always follows the settings. */
  setName(key: string, name: string | null): void {
    const all = { ...(store.extra<Record<string, string>>(NAMES_KEY) ?? {}) };
    const n = name?.trim().toLowerCase().replace(/\.+$/, '') ?? '';
    if (!n) delete all[key];
    else {
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(n)) throw new Error('A name is letters, digits and dashes, parts separated by dots — like shop or api.shop');
      if (/(^|\.)docatz$/.test(n)) throw new Error('The name comes before .docatz — leave that part out');
      if (Object.entries(all).some(([k, v]) => k !== key && v === n)) throw new Error(`${n}.docatz.${this.tld()} is already another container's name`);
      all[key] = n;
    }
    store.setExtra(NAMES_KEY, all);
    this.onChange();
  }

  /** https://<host>[:port] — without the port only when :443 / :80 reach DoCatz's proxy. */
  urlFor = (c: Omit<DcContainer, 'url'>): string | null => {
    const host = this.hostFor(c);
    if (!host || !isWeb(c)) return null;
    const https = this.https() && this.ca !== null;
    const clean = shared().cleanUrls?.on === true && this.probe?.reaches === true;
    return `${https ? 'https' : 'http'}://${host}${clean ? '' : `:${https ? this.httpsPort : this.httpPort}`}`;
  };

  /**
   * The proxy's table. A container with its own IP goes through the router to that IP and its port — the first exposed
   * port, else the one it listens on, else 80 — so nothing needs publishing (as OrbStack). A published port on
   * localhost is the fallback when the router cannot run.
   */
  async setRoutes(containers: DcContainer[]): Promise<void> {
    const next = new Map<string, { router: boolean; port: number }>();
    const targets: RouterTarget[] = [];
    for (const c of containers) {
      if (c.state !== 'running') {
        this.router.forget(c.id);
        continue;
      }
      const host = this.hostFor(c);
      if (!host) continue;
      const published = c.ports.filter((p) => p.type === 'tcp' && p.public);
      const fallback = (published.find((p) => WEB_PORTS.includes(p.private)) ?? published[0])?.public ?? null;
      if (c.ip) {
        // What it really listens on wins over what the image declares (an Octane app EXPOSEs 8080 but serves on 8000).
        const exposed = c.ports.filter((p) => p.type === 'tcp').map((p) => p.private);
        const all = (await this.router.listeningPorts(c.id)).filter((p) => !ADMIN_PORTS.includes(p));
        const listening = all.some((p) => !NOT_WEB.includes(p)) ? all.filter((p) => !NOT_WEB.includes(p)) : all;
        const web = (list: number[]) => WEB_PORTS.find((w) => list.includes(w));
        const port = web(listening.filter((p) => exposed.includes(p))) ?? web(listening) ?? listening.find((p) => exposed.includes(p)) ?? listening[0] ?? web(exposed) ?? exposed[0] ?? 80;
        targets.push({ host, ip: c.ip, port });
        next.set(host, { router: true, port });
      } else if (fallback) next.set(host, { router: false, port: fallback });
    }
    try {
      if (targets.length) await this.router.update(targets);
    } catch (e) {
      console.warn('DoCatz router:', (e as Error).message);
      // Without the router only published ports can be reached.
      for (const c of containers) {
        const host = this.hostFor(c);
        const p = c.ports.find((x) => x.type === 'tcp' && x.public);
        if (host && next.get(host)?.router) p?.public ? next.set(host, { router: false, port: p.public }) : next.delete(host);
      }
    }
    this.routes = next;
  }

  /** The local port to send a request to: the router's (it picks the container by Host) or a published port. */
  private target(req: IncomingMessage): number | null {
    const r = this.routes.get((req.headers.host ?? '').split(':')[0].toLowerCase());
    return r ? (r.router ? ROUTER_PORT : r.port) : null;
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader(MARK, '1');
    const port = this.target(req);
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
    if (!port && this.standIn.size && !host.endsWith(`.docatz.${this.tld()}`)) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>DevCatz is closed</title><body style="font:15px system-ui;padding:3rem;color:#334"><h2>${host.replace(/[<>&"]/g, '')} is a DevCatz site</h2><p>Open DevCatz to serve it. DoCatz answers here only for its own names while DevCatz is closed.</p>`);
      return;
    }
    if (!port) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>DoCatz</title><body style="font:15px system-ui;padding:3rem;color:#334"><h2>Nothing runs at ${String(req.headers.host ?? '').replace(/[<>&"]/g, '')}</h2><p>No running container has this name. Start it in DoCatz.</p>`);
      return;
    }
    // Through DevCatz's proxy (#80) the request arrives on the HTTP port with X-Forwarded-Proto https: keep it (never
    // redirect, or it loops); only DoCatz's own TLS port sets it.
    const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
    const proto = encrypted ? 'https' : String(req.headers['x-forwarded-proto'] ?? '') === 'https' ? 'https' : 'http';
    const up = httpRequest({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': proto, 'x-forwarded-host': (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`DoCatz could not reach the container on port ${port}: ${e.message}`);
    });
    req.pipe(up);
  }

  /** WebSockets (hot reload, live apps): the raw connection is passed through. */
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const port = this.target(req);
    if (!port) return void socket.destroy();
    const up = connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : [])), '', ''];
      up.write(lines.join('\r\n'));
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  }

  // ---------------------------------------------------------------- the shared CA

  /** The CA every Catzoid app uses: shared.json's, else DevCatz's (adopted), else a new one in Catzoid/ca. */
  private ensureCa(): void {
    if (this.ca) return;
    const load = (files: { cert: string; key: string; by: string }): Ca | null => {
      if (!existsSync(files.cert) || !existsSync(files.key)) return null;
      const pem = readFileSync(files.cert, 'utf8');
      return { cert: forge.pki.certificateFromPem(pem), key: forge.pki.privateKeyFromPem(readFileSync(files.key, 'utf8')) as forge.pki.rsa.PrivateKey, pem, files };
    };
    const s = shared().ca as (SharedDomains['ca'] & { owner?: string }) | undefined;
    this.ca = s ? load({ cert: s.cert, key: s.key, by: s.by ?? s.owner ?? 'devcatz' }) : null;
    if (this.ca) return;
    const devcatz = { cert: join(DEVCATZ_DATA, 'certs', 'ca.crt'), key: join(DEVCATZ_DATA, 'certs', 'ca.key'), by: 'devcatz' };
    this.ca = load(devcatz);
    if (this.ca) {
      writeShared({ domains: { ca: { ...devcatz, trusted: false } } });
      return;
    }
    const dir = join(SHARED_DIR, 'ca');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86_400_000);
    const attrs = [
      { name: 'commonName', value: CA_NAME },
      { name: 'organizationName', value: 'Catzoid' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }, { name: 'subjectKeyIdentifier' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const files = { cert: join(dir, 'ca.crt'), key: join(dir, 'ca.key'), by: ME };
    writeFileSync(files.cert, forge.pki.certificateToPem(cert));
    writeFileSync(files.key, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    writeShared({ domains: { ca: { ...files, trusted: false } } });
    this.ca = { cert, key: keys.privateKey, pem: forge.pki.certificateToPem(cert), files };
  }

  /** A leaf certificate for one host, signed by the shared CA, cached in DoCatz's data folder while valid. */
  private leaf(host: string): { cert: string; key: string } {
    this.ensureCa();
    const ca = this.ca!;
    const base = join(dataDir('certs'), host);
    if (existsSync(`${base}.crt`) && existsSync(`${base}.key`)) {
      const pem = { cert: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
      const x = new X509Certificate(pem.cert);
      if (new Date(x.validTo).getTime() - Date.now() > 30 * 86_400_000 && x.checkIssued(new X509Certificate(ca.pem))) return { cert: pem.cert + ca.pem, key: pem.key };
    }
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 397 * 86_400_000);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: host }] }]);
    cert.sign(ca.key, forge.md.sha256.create());
    const pem = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
    writeFileSync(`${base}.crt`, pem.cert);
    writeFileSync(`${base}.key`, pem.key, { mode: 0o600 });
    return { cert: pem.cert + ca.pem, key: pem.key };
  }

  private context(host: string): SecureContext {
    let ctx = this.contexts.get(host);
    if (!ctx) {
      ctx = createSecureContext(this.leaf(host.toLowerCase()));
      this.contexts.set(host, ctx);
    }
    return ctx;
  }

  private thumbprint(): string {
    return forge.md.sha1.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(this.ca!.cert)).getBytes()).digest().toHex().toUpperCase();
  }

  private async isTrusted(): Promise<boolean> {
    if (!this.ca) return false;
    if (isWin) return (await run('certutil', ['-user', '-verifystore', 'Root', this.thumbprint()], { timeout: 20_000 })).code === 0;
    const probe = join(dataDir('certs'), 'docatz.localhost.crt');
    this.leaf('docatz.localhost');
    return (await run('/usr/bin/security', ['verify-cert', '-c', probe, '-p', 'ssl', '-s', 'docatz.localhost', '-q'], { timeout: 20_000 })).code === 0;
  }

  private async recordTrust(): Promise<boolean> {
    const trusted = await this.isTrusted();
    const ca = shared().ca;
    if (this.ca && ca?.trusted !== trusted) writeShared({ domains: { ca: { ...this.ca.files, trusted } } });
    return trusted;
  }

  // ---------------------------------------------------------------- setup steps (as DevCatz's setupSteps)

  private async steps<T>(what: 'ca' | 'urls' | 'dns', title: string, steps: string[], work: (step: (i: number, detail?: string) => void) => Promise<T>, doneTitle: string): Promise<T> {
    clearTimeout(this.taskClear);
    const set = (p: Partial<TaskProgress>) => {
      this.task = { what, task: { ...(this.task?.what === what ? this.task.task : { kind: 'setup', title, steps, step: 0 }), ...p } };
      void this.state().then((s) => this.onState(s));
    };
    this.task = null;
    set({ step: 0 });
    let keep = 4000;
    try {
      const r = await work((i, detail) => set({ step: i, detail }));
      set({ step: steps.length, done: true, title: doneTitle, detail: undefined });
      return r;
    } catch (e) {
      const msg = (e as Error).message;
      set({ error: msg, cancelled: msg === 'Cancelled', done: true });
      keep = 12_000;
      throw e;
    } finally {
      this.taskClear = setTimeout(() => {
        this.task = null;
        void this.state().then((s) => this.onState(s));
      }, keep);
      this.probe = null;
      this.onChange();
    }
  }

  async trust(on: boolean): Promise<DcDomains> {
    const who = isWin ? 'Windows asks “install this certificate?”' : 'macOS asks for your password or Touch ID';
    if (on) {
      await this.steps('ca', `Trusting the ${CA_NAME}`, ['Prepare the shared local CA', `Add it to your ${isWin ? 'Trusted Root certificates' : 'login keychain'} — ${who}`, 'Check that it is trusted'], async (step) => {
        this.ensureCa();
        step(1, isWin ? 'Waiting for your answer: if Windows’ question is not in front, click the flashing key icon in the taskbar' : 'Waiting for your password');
        const r = isWin
          ? await run('certutil', ['-user', '-addstore', 'Root', this.ca!.files.cert], { timeout: 180_000 })
          : await run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', join(homedir(), 'Library/Keychains/login.keychain-db'), this.ca!.files.cert], { timeout: 180_000 });
        step(2);
        if (!(await this.recordTrust())) throw new Error(/cancel|-128|1223/i.test(r.stderr + r.stdout) || r.code !== 0 ? 'Cancelled' : lastLine(r.stderr || r.stdout) || 'The certificate was not trusted');
      }, 'Certificate trusted — reload your browser tabs');
    } else {
      await this.steps('ca', `Removing the ${CA_NAME}`, [`Remove it from your ${isWin ? 'Trusted Root certificates' : 'login keychain'} — ${who}`, 'Check that it is gone'], async (step) => {
        this.ensureCa();
        if (isWin) await run('certutil', ['-user', '-delstore', 'Root', this.thumbprint()], { timeout: 180_000 });
        else {
          await run('/usr/bin/security', ['remove-trusted-cert', this.ca!.files.cert], { timeout: 180_000 });
          await run('/usr/bin/security', ['delete-certificate', '-Z', this.thumbprint(), join(homedir(), 'Library/Keychains/login.keychain-db')], { timeout: 180_000 });
        }
        step(1);
        if (await this.recordTrust()) throw new Error('The certificate is still trusted (the question was answered No?)');
      }, 'Certificate removed');
    }
    return this.state();
  }

  /** :443 / :80 → DevCatz's proxy when DevCatz is here (its sites keep working), else DoCatz's. */
  private forwardPorts(): { httpsPort: number; httpPort: number; by: string } {
    if (!this.devcatz) return { httpsPort: this.httpsPort, httpPort: this.httpPort, by: ME };
    const c = shared().cleanUrls;
    if (c?.by === 'devcatz') return { httpsPort: c.httpsPort, httpPort: c.httpPort, by: 'devcatz' };
    const d = devcatzConfig();
    return { httpsPort: d.httpsPort ?? 8443, httpPort: d.httpPort ?? 8180, by: 'devcatz' };
  }

  async cleanUrls(on: boolean): Promise<DcDomains> {
    const admin = isWin ? 'administrator approval' : 'your administrator password';
    if (on) {
      const f = this.forwardPorts();
      await this.steps('urls', 'Turning on names without a port', ['Check ports 443 and 80', `Forward ports 443 and 80 to ${f.by === ME ? 'DoCatz' : 'DevCatz'} — ${admin}`, 'Check that names answer without a port'], async (step) => {
        step(1, isWin ? 'netsh interface portproxy, through one administrator prompt' : 'LaunchDaemons with /usr/bin/nc, through one password prompt');
        const r = await installForward(f.httpsPort, f.httpPort, 'DoCatz wants to forward ports 443 and 80 to the local proxy so names work without a port.');
        if (!r.ok) throw new Error(cancelled(r) ? 'Cancelled' : r.message);
        writeShared({ domains: { cleanUrls: { on: true, ...f } } });
        step(2);
        if ((await forwardTarget()) !== f.httpsPort) throw new Error('The forwarding did not take: try again');
      }, 'Names without a port are on');
    } else {
      await this.steps('urls', 'Turning off names without a port', [`Remove the forwarding of ports 443 and 80 — ${admin}`, 'Check that it is gone'], async (step) => {
        const r = await uninstallForward('DoCatz wants to remove the port forwarding.');
        if (!r.ok) throw new Error(cancelled(r) ? 'Cancelled' : r.message);
        const c = shared().cleanUrls;
        writeShared({ domains: { cleanUrls: { ...(c ?? this.forwardPorts()), on: false } } });
        step(1);
        if ((await forwardTarget()) !== null) throw new Error('The forwarding is still there');
      }, 'Names without a port are off');
    }
    return this.state();
  }

  async resolver(on: boolean): Promise<DcDomains> {
    const tld = this.tld();
    const zones = resolverZones(tld);
    const names = zones.map((z) => `*.${z}`).join(' and ');
    if (on) {
      await this.steps('dns', isWin ? 'Adding DNS rules' : 'Installing the resolver', [`Start the local DNS on ${DNS_HOST}:${DNS_PORT}`, isWin ? `Add Windows DNS rules (NRPT) for ${names} — administrator approval` : `Create /etc/resolver/${tld} — your administrator password`, `Check that ${names} resolve to this ${isWin ? 'PC' : 'Mac'}`], async (step) => {
        await this.startDns();
        // DevCatz may already answer on that address: then DoCatz needs no DNS of its own.
        if (!this.dns.running && !(await this.devcatzDns())) throw new Error(this.dns.error ?? `The local DNS could not start on port ${DNS_PORT}`);
        step(1, isWin ? 'Add-DnsClientNrptRule, through one administrator prompt' : 'One password prompt');
        const r = await installResolver(tld, DNS_HOST, DNS_PORT, `DoCatz wants to resolve ${names} to this Mac.`);
        if (!r.ok) throw new Error(cancelled(r) ? 'Cancelled' : r.message);
        step(2);
        for (let i = 0; i < 8 && !(await this.resolves()); i++) await new Promise((res) => setTimeout(res, 500));
        if (!(await this.resolves())) throw new Error(`The ${isWin ? 'rules are' : 'resolver is'} in place, but ${names} does not resolve yet: try again in a moment`);
      }, `${names} resolves to this ${isWin ? 'PC' : 'Mac'}`);
    } else {
      await this.steps('dns', isWin ? 'Removing DNS rules' : 'Removing the resolver', [isWin ? 'Remove the DNS rules (NRPT) — administrator approval' : `Remove /etc/resolver/${tld} — your administrator password`, 'Check that they are gone'], async (step) => {
        const r = await uninstallResolver(tld, DNS_HOST, `DoCatz wants to stop resolving ${names}.`);
        if (!r.ok) throw new Error(cancelled(r) ? 'Cancelled' : r.message);
        step(1);
      }, isWin ? 'DNS rules removed' : 'Resolver removed');
    }
    return this.state();
  }

  /** A name under the zones resolves to this computer. */
  private async resolves(): Promise<boolean> {
    const zones = resolverZones(this.tld());
    if (!zones.length) return true;
    try {
      const r = await lookup(`docatz-check.docatz.${zones[0]}`);
      return r.address === '127.0.0.1' || r.address === '::1';
    } catch {
      return false;
    }
  }

  /** Another app (DevCatz) answers DNS on the shared address. */
  private async devcatzDns(): Promise<boolean> {
    return this.devcatz !== null && /EADDRINUSE|taken|DevCatz/i.test(this.dns.error ?? '');
  }

  /** Does https://<name>.docatz.<tld> on :443 reach DoCatz's proxy (directly or through DevCatz's)? 'down': nothing answers there. */
  private reachesDocatz(): Promise<'yes' | 'no' | 'down'> {
    return new Promise((resolve) => {
      const host = `docatz-check.docatz.${this.tld()}`;
      const req = httpsRequest({ host: '::1', port: 443, path: '/', servername: host, headers: { host }, rejectUnauthorized: false, timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.headers[MARK] === '1' ? 'yes' : 'no');
      });
      req.on('error', () => resolve('down'));
      req.on('timeout', () => {
        req.destroy();
        resolve('down');
      });
      req.end();
    });
  }

  // ---------------------------------------------------------------- state and settings

  async state(): Promise<DcDomains> {
    try {
      this.ensureCa();
    } catch {
      /* no CA yet */
    }
    const d = shared();
    const tld = this.tld();
    const zones = resolverZones(tld);
    if (!this.probe || Date.now() - this.probe.at > 20_000) {
      const [r, resolves] = await Promise.all([d.cleanUrls?.on ? this.reachesDocatz() : Promise.resolve('no' as const), this.resolves()]);
      this.probe = { at: Date.now(), reaches: r === 'yes', frontDown: r === 'down', resolves };
    }
    const trusted = this.ca ? (d.ca?.trusted ?? (await this.recordTrust())) : false;
    return {
      tld,
      https: this.https(),
      ca: this.ca ? { cert: this.ca.files.cert, by: this.ca.files.by, trusted } : null,
      cleanUrls: { on: d.cleanUrls?.on === true, by: d.cleanUrls?.on ? d.cleanUrls.by : null, reachesDocatz: this.probe.reaches, frontDown: this.probe.frontDown === true },
      httpsPort: this.httpsPort,
      httpPort: this.httpPort,
      resolver: { needed: zones.length > 0, status: zones.length ? await resolverStatus(tld, DNS_HOST).catch(() => 'none' as const) : 'ours', resolves: this.probe.resolves, dnsError: this.dns.running || (await this.devcatzDns()) ? null : this.dns.error, zones },
      devcatz: this.devcatz !== null,
      task: this.task,
    };
  }

  /** Re-checks trust (the user may have changed it in Keychain Access / certmgr) and the probes. */
  async refresh(): Promise<DcDomains> {
    this.probe = null;
    if (this.ca) await this.recordTrust();
    return this.state();
  }

  async set(patch: DcDomainsPatch): Promise<DcDomains> {
    if (patch.tld !== undefined) {
      const tld = patch.tld.trim().toLowerCase().replace(/^\./, '');
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(tld)) throw new Error('A domain ending is letters, digits and dashes, like localhost or test');
      if (['com', 'net', 'org', 'io', 'dev', 'app', 'local'].includes(tld)) throw new Error(`.${tld} is a real (or reserved) domain ending — pick localhost or test`);
      if ((await resolverStatus(tld, DNS_HOST).catch(() => 'none')) === 'foreign') throw new Error(`Another tool already resolves .${tld} — pick another ending`);
      writeShared({ domains: { tld } });
      this.contexts.clear();
      await this.startDns();
    }
    if (patch.https !== undefined) store.setExtra(HTTPS_KEY, patch.https === true);
    this.probe = null;
    this.onChange();
    return this.state();
  }

  /**
   * Uninstall (DoCatz TODO #33, the rule DevCatz follows too): DoCatz leaves `usedBy`; the forwarding and resolver go
   * only when no other installed app is listed there. `removeCa` (the shared settings go too): the local CA DoCatz made
   * leaves the trusted roots as well, so no trusted certificate is left whose files are gone.
   */
  async uninstall(removeCa = false): Promise<void> {
    const d = shared();
    const others = (d.usedBy ?? []).filter((a) => a !== ME);
    writeShared({ domains: { usedBy: others } });
    // Only apps still installed count (a listed app that is gone keeps nothing alive).
    const installed = await Promise.all(others.map((a) => (a === 'devcatz' ? findCatzoidApp('DevCatz', 'devcatz', 'com.mrcatz.devcatz').catch(() => null) : Promise.resolve('unknown'))));
    if (installed.some(Boolean)) return;
    if (removeCa && d.ca?.by === ME && this.ca && (await this.isTrusted().catch(() => false))) await this.trust(false).catch((e) => console.warn('uninstall: CA still trusted:', (e as Error).message));
    await uninstallForward('DoCatz wants to remove the port forwarding it installed.').catch(() => undefined);
    await uninstallResolver(this.tld(), DNS_HOST, 'DoCatz wants to remove the resolver it installed.').catch(() => undefined);
  }
}
