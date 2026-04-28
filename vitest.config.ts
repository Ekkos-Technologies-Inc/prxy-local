import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    pool: 'forks',
    testTimeout: 30_000,
    // hookTimeout bumped from 15s to 30s in v0.3.0 — adding the AWS SDK
    // (Bedrock + S3 clients) to the import graph pushes cold-start import
    // time past 15s on slower machines.
    hookTimeout: 30_000,
  },
});
