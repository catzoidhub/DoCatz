import type { DoCatzBridge } from './index';

declare global {
  interface Window {
    docatz: DoCatzBridge;
  }
}

export {};
