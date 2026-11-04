import type { ActionDef } from '@catzoid/mcatzp-host';
import type { DoCatzApi } from '@shared/types';
import { readActions } from './actions';

/** Every tool with everything shared, for the reference and the coverage test. Nothing here runs: the API is never called. */
export function allActions(): ActionDef[] {
  const api = new Proxy({}, { get: () => () => { throw new Error('The registry is only listed here'); } }) as DoCatzApi;
  return readActions(api, { project: () => true, loose: true, logs: true, resources: true, changes: true }, { databasePasswords: () => [], logsTail: () => Promise.resolve([]) });
}
