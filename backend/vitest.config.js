import { defineConfig } from 'vitest/config';

// Tests run in their own schema; each test file re-seeds it. Files run one at a time (shared DB).
export default defineConfig({
  test: {
    env: { DB_SCHEMA: 'nfpl_test' },
    include: ['tests/**/*.test.js'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
