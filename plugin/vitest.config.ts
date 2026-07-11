import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'plugin',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
