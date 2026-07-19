import { defineConfig } from 'vitest/config'

// Integration suite: requires a live Postgres (`docker compose up -d`) reachable
// at DATABASE_URL. Run with `npm run test:integration`. Kept out of the default
// `npm run test` / `npm run verify` gate so unit tests pass with Docker down.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    // Migrations + shared tables: run integration files serially, no parallel DB races.
    fileParallelism: false,
    testTimeout: 20000,
  },
})
