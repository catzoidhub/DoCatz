import { homedir, tmpdir } from 'node:os';

/**
 * The engine helper (#107) runs DoCatz's own executable as plain Node (ELECTRON_RUN_AS_NODE=1), where `electron` has no
 * app / net / shell. The modules it shares with the app import only these few members; this stub gives them the same
 * answers from what the app passes in the environment (DOCATZ_USERDATA, DOCATZ_VERSION, DOCATZ_PACKAGED).
 */
export const app = {
  getPath(name: string): string {
    if (name === 'userData') return process.env.DOCATZ_USERDATA || '';
    if (name === 'home') return homedir();
    if (name === 'temp') return tmpdir();
    throw new Error(`app.getPath('${name}') is not available in the engine helper`);
  },
  getVersion: (): string => process.env.DOCATZ_VERSION || '0.0.0',
  get isPackaged(): boolean {
    return process.env.DOCATZ_PACKAGED === '1';
  },
  getApplicationInfoForProtocol: (): Promise<never> => Promise.reject(new Error('not in the engine helper')),
};

export const net = { fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init) };

export const shell = {
  openExternal: (): Promise<void> => Promise.reject(new Error('The engine helper opens no windows')),
};

export default { app, net, shell };
