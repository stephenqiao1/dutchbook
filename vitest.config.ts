import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Health probes are injected in tests, so nothing here should hit the network.
    testTimeout: 10_000,
  },
});
