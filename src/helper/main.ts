import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { release } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { forwardBridgeMcatzp, keepBridgeMcatzp, setBridgeHelper, setBridgeMcatzp } from '../main/bridge';
import { EngineHost } from '../main/enginehost';
import { HELPER_PROTOCOL, HelperClient, helperSocket, helperToken, onLines, type HelperEvent, type HelperRequest } from '../main/helperproto';
import { isWin } from '../main/platform';

/**
 * DoCatz's engine helper (#107): DoCatz's own executable run as plain Node, started by DoCatz (a launchd agent on macOS,
 * a detached process elsewhere until Windows / Linux get their own), so the engine, the domains proxy, the database
 * ports, the file events and bridge.json keep running with the window closed and DoCatz quit. DoCatz talks to it over
 * the control channel (helperproto.ts). One helper per user: a second one finds the first answering and leaves.
 */

const VERSION = process.env.DOCATZ_VERSION || '0.0.0';

// Electron's own `process` members the shared modules call (lima.ts checks the macOS version).
const proc = process as NodeJS.Process & { getSystemVersion?: () => string };
if (!proc.getSystemVersion) {
  let v = '';
  proc.getSystemVersion = () => {
    if (v) return v;
    try {
      v = process.platform === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : release();
    } catch {
      v = release();
    }
    return v;
  };
}
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function main(): Promise<void> {
  // Already running (two starts in a row, launchd and DoCatz at once): leave it be.
  const probe = new HelperClient();
  if (await probe.connect(800)) {
    probe.close();
    log('another engine helper answers; leaving');
    process.exit(0);
  }

  const token = helperToken(true);
  const host = new EngineHost();
  const clients = new Set<Socket>();
  const emit = (e: HelperEvent) => {
    const line = `${JSON.stringify(e)}\n`;
    for (const c of clients) if (!c.destroyed) c.write(line);
  };
  host.onEngine = (s) => emit({ event: 'engine', data: s });
  host.onDomains = (d) => emit({ event: 'domains', data: d });
  host.onList = () => emit({ event: 'list', data: null });

  keepBridgeMcatzp();
  setBridgeHelper({ pid: process.pid, version: VERSION });
  // The app's MCatzP entry reaches bridge.json through here: one process writes the file.
  forwardBridgeMcatzp(null);

  let quitting = false;
  async function quit(stopEngine: boolean): Promise<void> {
    if (quitting) return;
    quitting = true;
    log(`quitting${stopEngine ? ' with the engine' : ''}`);
    emit({ event: 'bye', data: null });
    if (stopEngine) await host.engine.stop().catch((e) => log('engine stop:', (e as Error).message));
    setBridgeHelper(null);
    host.dispose();
    server.close();
    if (!isWin && existsSync(helperSocket())) unlinkSync(helperSocket());
    setTimeout(() => process.exit(0), 200);
  }

  const engineMethods = new Set(['state', 'up', 'start', 'stop', 'restart', 'reset', 'configure', 'cancel', 'adopt', 'setupWsl', 'log', 'setContext', 'installCli', 'setPath']);
  async function handle(req: HelperRequest): Promise<unknown> {
    const [ns, m] = req.method.split('.', 2);
    const args = Array.isArray(req.args) ? req.args : [];
    if (ns === 'engine' && engineMethods.has(m)) {
      const fn = (host.engine as unknown as Record<string, (...a: unknown[]) => unknown>)[m];
      return await fn.apply(host.engine, args);
    }
    switch (req.method) {
      case 'helper.version':
        return { version: VERSION, protocol: HELPER_PROTOCOL, pid: process.pid, build: process.env.DOCATZ_HELPER_BUILD || '' };
      case 'helper.quit':
        void quit(args[0] === true);
        return true;
      case 'engine.sleeping':
        return (await host.engine.backend.sleeping?.()) ?? false;
      case 'engine.trim':
        await host.engine.backend.trim?.();
        return true;
      case 'host.refresh':
        await host.refresh();
        return true;
      case 'host.containers':
        return host.containers;
      // The window changed the domains' settings (TLD, HTTPS, CA, names without a port, resolver): the proxy starts again.
      case 'domains.reload':
        host.domains.stop();
        await host.domains.start();
        await host.refresh();
        return true;
      case 'domains.naming':
        return host.domains.naming();
      case 'domains.setName':
        host.domains.setName(String(args[0]), args[1] === null ? null : String(args[1]));
        return true;
      case 'bridge.mcatzp':
        setBridgeMcatzp(args[0] as Parameters<typeof setBridgeMcatzp>[0]);
        await host.refresh();
        return true;
    }
    throw new Error(`Unknown request ${req.method}`);
  }

  const server = createServer((socket) => {
    onLines(socket, (msg) => {
      const req = msg as HelperRequest;
      if (typeof req?.id !== 'number' || typeof req.method !== 'string') return;
      if (req.token !== token) {
        socket.write(`${JSON.stringify({ id: req.id, ok: false, error: 'Not allowed' })}\n`);
        return socket.destroy();
      }
      clients.add(socket);
      handle(req).then(
        (result) => !socket.destroyed && socket.write(`${JSON.stringify({ id: req.id, ok: true, result: result ?? null })}\n`),
        (e) => !socket.destroyed && socket.write(`${JSON.stringify({ id: req.id, ok: false, error: (e as Error).message })}\n`),
      );
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => undefined);
  });
  if (!isWin && existsSync(helperSocket())) unlinkSync(helperSocket());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(helperSocket(), () => resolve());
  });
  if (!isWin) chmodSync(helperSocket(), 0o600);
  log(`engine helper ${VERSION} (pid ${process.pid}) listening on ${helperSocket()}`);

  process.on('SIGTERM', () => void quit(false));
  process.on('SIGINT', () => void quit(false));

  await host.start();
  if (await host.engine.up()) void host.engine.adopt().catch((e) => log('adopt:', (e as Error).message));
  else {
    const s = await host.engine.state();
    if (s.status === 'stopped' && s.config.autoStart) void host.engine.start().catch((e) => log('engine autostart:', (e as Error).message));
  }
  // A light poll while nothing else tells us (the VM stopped from outside), and the :443 probe that decides names
  // without a port (DevCatz's front may come or go): DoCatz names its URLs from it (domains.naming).
  setInterval(() => void host.domains.state().catch(() => undefined).then(() => host.refresh()), 30_000);
}

main().catch((e) => {
  console.error('engine helper:', e);
  process.exit(1);
});
