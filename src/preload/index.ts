import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, type DcDomains, type DcLogChunk, type DcRun, type DcTermData, type DcUpdateState, type DoCatzApi, type DoCatzSettings, type EngineState } from '@shared/types';

const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`docatz:${m}`, ...args)])) as unknown as DoCatzApi;

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  // One listener that throws (e.g. returns a value the context bridge cannot clone) must not stop the others.
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(`${channel} listener failed:`, e);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const bridge = {
  ...api,
  /** App menu / tray commands. */
  onCommand: (cb: (c: { command: string; arg?: string }) => void) => on('app:command', cb),
  /** A place to show (docatz:// link, tray): containers/<name>, compose/<path>, settings … */
  onOpen: (cb: (route: string) => void) => on('app:open', cb),
  /** The engine's state changed (status, a setup step, settings). */
  onEngine: (cb: (s: EngineState) => void) => on('app:engine', cb),
  /** Containers, images, volumes or networks changed (engine events). */
  onChanged: (cb: () => void) => on('app:changed', cb),
  /** A domain setup step moved (trust, forwarding, resolver). */
  onDomains: (cb: (d: DcDomains) => void) => on('app:domains', cb),
  onLogs: (cb: (c: DcLogChunk) => void) => on('app:logs', cb),
  onTerm: (cb: (d: DcTermData) => void) => on('app:term', cb),
  /** A compose run or image pull as it goes. */
  onRun: (cb: (r: DcRun) => void) => on('app:run', cb),
  /** The settings changed outside the window (another Catzoid app changed the shared theme / AI connection). */
  onSettings: (cb: (s: DoCatzSettings) => void) => on('app:settings', cb),
  onUpdate: (cb: (s: DcUpdateState) => void) => on('app:update', cb),
  onUpdateOpen: (cb: () => void) => on('app:updateOpen', cb),
  onReportsAsk: (cb: () => void) => on('app:reportsAsk', cb),
};

export type DoCatzBridge = typeof bridge;

contextBridge.exposeInMainWorld('docatz', bridge);
