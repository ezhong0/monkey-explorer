import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Pure Node environment — no jsdom; the only side-effecting modules
    // (fs, network) are touched by tests that mock them explicitly.
    environment: 'node',
    // Tests should be fast; cap at 5s per test to surface slowness.
    testTimeout: 5_000,
  },
});
