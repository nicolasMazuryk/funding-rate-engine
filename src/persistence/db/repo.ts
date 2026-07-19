/**
 * Postgres `Repo` implementation (`14` §3, §7) — tier 2 of persistence.
 *
 * Implements the `Repo` port from `src/core/ports/`; the pure core never sees
 * Drizzle or `pg`. Every query is scoped to the closed-over instance triple so
 * instances stay isolated inside the one fleet-wide database (`14` §3).
 */

import { and, eq, notInArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { TERMINAL_INTENT_STATES } from '../../core/intent/intent-machine.js'
import type { IntentSnapshot, Repo } from '../../core/ports/index.js'
import type { Instance } from './instance.js'
import { intents } from './schema.js'

/** Build a `Repo` backed by `pool`, scoped to `instance`. */
export function createPgRepo({ pool, instance }: { readonly pool: Pool; readonly instance: Instance }): Repo {
  const db = drizzle(pool)

  return {
    async upsertIntentState(snapshot: IntentSnapshot): Promise<void> {
      const row = {
        intentId: snapshot.intentId,
        exchange: instance.exchange,
        strategy: instance.strategy,
        subaccount: instance.subaccount,
        symbol: snapshot.symbol,
        state: snapshot.state,
        tSettleMs: snapshot.tSettleMs ?? null,
        exitReason: snapshot.exitReason ?? null,
        errorCode: snapshot.errorCode ?? null,
        configHash: snapshot.configHash ?? null,
      }
      await db
        .insert(intents)
        .values(row)
        .onConflictDoUpdate({
          target: intents.intentId,
          set: {
            symbol: row.symbol,
            state: row.state,
            tSettleMs: row.tSettleMs,
            exitReason: row.exitReason,
            errorCode: row.errorCode,
            configHash: row.configHash,
          },
        })
    },

    async loadNonTerminalIntents(): Promise<readonly IntentSnapshot[]> {
      const rows = await db
        .select()
        .from(intents)
        .where(
          and(
            eq(intents.exchange, instance.exchange),
            eq(intents.strategy, instance.strategy),
            eq(intents.subaccount, instance.subaccount),
            notInArray(intents.state, [...TERMINAL_INTENT_STATES]),
          ),
        )
      return rows.map((r) => ({
        intentId: r.intentId,
        state: r.state,
        symbol: r.symbol,
        tSettleMs: r.tSettleMs ?? undefined,
        exitReason: r.exitReason ?? undefined,
        errorCode: r.errorCode ?? undefined,
        configHash: r.configHash ?? undefined,
      }))
    },
  }
}
