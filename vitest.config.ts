import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never reach a real model: force the mock provider.
    env: { LLM_PROVIDER: 'mock', LOG_LEVEL: 'silent' },
    testTimeout: 20000,
  },
});
