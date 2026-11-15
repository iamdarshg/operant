import { defineConfig } from 'vitest/config';

/**
 * The bot's tests never touch the network or a Discord gateway. Every external
 * edge (HTTP, discord.js objects, timers) is injected or faked per test, so the
 * suite is deterministic and can run on a machine with no bot token.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A leaked timer or a fire-and-forget tracker would otherwise hang the run.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
  },
});