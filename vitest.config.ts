import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test builds its own ephemeral PGlite instance, and spinning up a
    // WebAssembly Postgres is not free, so the default timeout is a little short.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
