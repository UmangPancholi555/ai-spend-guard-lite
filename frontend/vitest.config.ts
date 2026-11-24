import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Frontend unit tests (React components in jsdom). Reuses the Vite aliases (@shared, @).
export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
}));
