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
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { '/api': `http://localhost:${apiPort}` },
  },
});
