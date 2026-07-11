import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['shared/vitest.config.ts', 'server/vitest.config.ts', 'plugin/vitest.config.ts'],
  },
});
