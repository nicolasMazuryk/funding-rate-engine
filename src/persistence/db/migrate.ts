/**
 * Migration runner — applies the committed SQL migrations under `./migrations`
 * to the database at `DATABASE_URL` (`14` §3: "migrations under version
 * control"). Run via `npm run db:migrate`.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop'

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    await migrate(drizzle(pool), { migrationsFolder: 'src/persistence/db/migrations' })
    console.log('[db:migrate] migrations applied')
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  console.error(`[db:migrate] failed: ${(err as Error).message}`)
  process.exit(1)
})
