import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export default defineConfig({
  // publicDir defaults to viewer/public/.
  // Static sprites at viewer/public/assets/sprites/units/*.png are served at
  // /assets/sprites/units/*.png at dev time and copied to dist/ at build time.
  // GitHub Pages project sites live under /<repo>/, so the workflow injects
  // VITE_BASE=/<repo>/ at build time. Local dev/build defaults to '/'.
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: 5173,
    strictPort: false,
    fs: {
      // Permit ?raw imports from engine/maps/*.txt and replays/*.json at the repo root.
      allow: [REPO_ROOT],
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    // ES modules required so the Pyodide worker can dynamic-import its WASM
    // shim. Default 'iife' breaks code-splitting for module workers.
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
