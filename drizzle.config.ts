import { defineConfig } from 'drizzle-kit'

// Drizzle Kit config: generates migrations from the typed schema (14 §3).
// `DATABASE_URL` matches docker-compose.yml / .env.example.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/persistence/db/schema.ts',
  out: './src/persistence/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop',
  },
})
