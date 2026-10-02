import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false, // integration suites share one database
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 20_000,
  },
});
