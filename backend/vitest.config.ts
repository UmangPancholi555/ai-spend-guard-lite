import path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
    fileParallelism: true,
    // `npm run test:coverage` (text summary in the terminal + HTML report). Output lives under <repo>/coverage/ (git-ignored).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: path.resolve(__dirname, '../coverage/backend'),
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
