import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // the packaged app talks to its backend over IPC only: the development endpoints leave its security policy
      name: 'production-csp',
      apply: 'build',
      // (no data: or blob: frames either: the only frames are the visualizer's isolated tpviz: origin and sandboxed srcdoc pages)
      transformIndexHtml: (html) =>
        html
          .replace(" connect-src 'self' http://127.0.0.1:5174 ws://localhost:5173 http://localhost:5173;", " connect-src 'self';")
          .replace(" frame-src 'self' blob: data: tpviz:", " frame-src 'self' tpviz:"),
    },
  ],
  base: './',
  clearScreen: false,
  server: {
    // browser development mode: the backend bridge is proxied so there is no CORS surface
    proxy: {
      // the bridge token (TESTPION_BRIDGE_TOKEN, set by scripts/dev.mjs) is added here as a header: never in the page, never in a URL
      '/__aps': { target: 'http://127.0.0.1:5174', changeOrigin: true, rewrite: (p) => p.replace(/^\/__aps/, ''), headers: { 'x-aps-token': process.env.TESTPION_BRIDGE_TOKEN ?? '' } },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
    target: 'chrome130',
    // TESTPION_PROFILE=1: readable function names in a CPU profile (e2e "profile:" steps)
    minify: process.env.TESTPION_PROFILE ? false : 'esbuild',
  },
  worker: { format: 'es' },
});
