import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, pool: 'forks' },
});
