/**
 * Drizzle schema — centralized Postgres, walking-skeleton scale (`14` §3).
 *
 * Two tables only now; the full 7-more-table schema is task 0360. Every row
 * carries the `instance_id` triple (`exchange`, `strategy`, `subaccount`) and
 * every query is scoped by it — instances stay logically isolated inside the
 * one fleet-wide database (`14` §3, `16`).
 *
 * Nullable columns: upstream producers of `t_settle_ms` (scheduler) and
 * `config_hash` (`09` config system, 0100) don't exist yet, and terminal
 * `exit_reason`/`error_code` are set only on terminal transitions — all
 * nullable for now, sharpened as those producers land.
 */

import { and, eq } from 'drizzle-orm'
import { bigint, index, jsonb, type PgColumn, pgTable, serial, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { Instance } from './instance.js'

/** One row per intent: current FSM state + identity, scoped by instance (`14` §3). */
export const intents = pgTable(
  'intents',
  {
    intentId: text('intent_id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    symbol: text('symbol').notNull(),
    /** Settlement time, epoch ms UTC (`00_globals` §1.2). Nullable until scheduler wires it. */
    tSettleMs: bigint('t_settle_ms', { mode: 'number' }),
    /** Current intent FSM state (`12` §5). */
    state: text('state').notNull(),
    /** `00_globals` §10.1, set only on `→ CLOSED`. */
    exitReason: text('exit_reason'),
    /** `00_globals` §10.2, set only on terminal error paths. */
    errorCode: text('error_code'),
    /** `09` §7 config revision hash; producer lands in 0100. */
    configHash: text('config_hash'),
  },
  (table) => [index('intents_instance_idx').on(table.exchange, table.strategy, table.subaccount)],
)

/**
 * Append-only transition log, forwarded from the local per-instance WAL file
 * (`14` §2.1). Idempotent at the store: the natural key
 * `(intent_id, from_state, to_state)` (`14` §4) makes a re-forwarded entry a
 * no-op upsert, never a double count.
 */
export const intentWal = pgTable(
  'intent_wal',
  {
    id: serial('id').primaryKey(),
    /** Local per-instance monotonic sequence from the WAL file (`wal-file.ts`). */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    /** Transition time, epoch ms UTC (`14` §2). */
    ts: bigint('ts', { mode: 'number' }).notNull(),
    intentId: text('intent_id').notNull(),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    payload: jsonb('payload'),
    clientOrderId: text('client_order_id'),
  },
  (table) => [
    uniqueIndex('intent_wal_natural_key').on(table.intentId, table.fromState, table.toState),
    index('intent_wal_instance_seq_idx').on(table.exchange, table.strategy, table.subaccount, table.seq),
  ],
)

/** Columns every instance-scoped table carries (`14` §3). */
interface InstanceScoped {
  readonly exchange: PgColumn
  readonly strategy: PgColumn
  readonly subaccount: PgColumn
}

/** The `(exchange, strategy, subaccount)` equality filter that scopes a query to one instance. */
export function instanceWhere(table: InstanceScoped, instance: Instance) {
  return and(
    eq(table.exchange, instance.exchange),
    eq(table.strategy, instance.strategy),
    eq(table.subaccount, instance.subaccount),
  )
}
