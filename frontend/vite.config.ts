import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const apiPort = process.env.API_PORT ?? '4000';
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // charts (Recharts + d3) are by far the heaviest dependency: keep them, and the React runtime, in their own cacheable chunks
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(recharts|recharts-scale|victory-vendor|d3-[^/]+|internmap|decimal\.js-light|lodash|react-smooth|react-transition-group|dom-helpers|fast-equals|eventemitter3|tiny-invariant|clsx)\//.test(id)) return 'charts';
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|@remix-run|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
});
