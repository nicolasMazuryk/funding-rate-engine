import { defineConfig } from 'vitest/config'

// E2E suite: boots a full instance against a live Postgres (`docker compose up -d`)
// + a real local WAL. Run with `npm run test:e2e`. Kept out of the default
// `npm run test` / `npm run verify` gate so unit tests pass with Docker down.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    // Migrations + shared tables: run e2e files serially, no parallel DB races.
    fileParallelism: false,
    testTimeout: 20000,
  },
})
