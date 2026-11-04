import type { ActionDef } from '@catzoid/mcatzp-host';
import type { DoCatzApi } from '@shared/types';
import { readActions, type EngineReads, type Scopes } from './actions';
import { changeActions } from './changes';
import { destructiveActions } from './destructive';

/** Every tool with everything shared, for the reference and the coverage test. Nothing here runs: the API is never called. */
export function allActions(): ActionDef[] {
  const api = new Proxy({}, { get: () => () => { throw new Error('The registry is only listed here'); } }) as DoCatzApi;
  const scopes: Scopes = { project: () => true, loose: true, logs: true, resources: true, envValues: true, secretName: () => false, changes: true, all: true };
  const reads: EngineReads = { databasePasswords: () => [], logsTail: () => Promise.resolve([]), run: () => null, runs: () => [] };
  return [...readActions(api, scopes, reads), ...changeActions(api, scopes, reads), ...destructiveActions(api, scopes, reads)];
}
