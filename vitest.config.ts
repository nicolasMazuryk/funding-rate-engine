import { defineConfig } from 'vitest/config'

// Unit suite: no Docker/Postgres. Integration tests (test/integration/**) need a
// live DB and run via vitest.integration.config.ts + `npm run test:integration`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'test/e2e/**', 'node_modules/**'],
  },
})
