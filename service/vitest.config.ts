import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every test file creates its own PostgreSQL schema, so files may run in parallel;
    // keep it sequential by default for stable timings on small CI machines.
    fileParallelism: false,
  },
});
