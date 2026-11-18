import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import pkg from './package.json';

/**
 * The engine helper (#107, src/helper/main.ts): a plain Node program run by DoCatz's own executable with
 * ELECTRON_RUN_AS_NODE=1. Built apart from the app so `electron` can point at a stub (there is no app / net / shell in
 * Node mode) while the engine, proxy and bridge modules stay shared and unchanged. Output: out/helper/index.js (in the
 * app's asar, next to out/main).
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve('src/helper/electron-stub.ts'),
      '@shared': resolve('src/shared'),
    },
  },
  build: {
    ssr: resolve('src/helper/main.ts'),
    outDir: 'out/helper',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...Object.keys(pkg.dependencies ?? {})],
      output: { format: 'cjs', entryFileNames: 'index.js' },
    },
  },
  ssr: { noExternal: true, external: Object.keys(pkg.dependencies ?? {}) },
});
