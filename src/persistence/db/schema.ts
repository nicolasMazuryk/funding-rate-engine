/**
 * Drizzle schema — centralized Postgres, full fleet scale (`14` §3).
 *
 * Every row carries the `instance_id` triple (`exchange`, `strategy`,
 * `subaccount`) and every query is scoped by it — instances stay logically
 * isolated inside the one fleet-wide database (`14` §3, `16`). Each table also
 * carries a **natural-key unique index** (incl. the triple) so the idempotent
 * repos (`db/repo.ts`) upsert/append-once by it (`14` §4).
 *
 * Nullable columns: upstream producers of `t_settle_ms` (scheduler) and
 * `config_hash` (`09` config system, 0100) don't exist yet, and terminal
 * `exit_reason`/`error_code` are set only on terminal transitions — all
 * nullable for now, sharpened as those producers land. `pnl` is written by the
 * accounting sidecar (0390); `reconciliation` by the reconciler (0400).
 */

import { and, eq } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  type PgColumn,
  pgEnum,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { ERROR_CODES, EXIT_REASONS } from '../../core/intent/intent-machine.js'
import type { Instance } from './instance.js'

/**
 * `exit_reason` / `error_code` pg enums, single-sourced from the FSM's `as const`
 * arrays (core → persistence import is allowed; the reverse is forbidden). Typed
 * columns catch enum drift at the DB boundary; `enum-parity.test.ts` guards the
 * two lists stay set-equal (R12). Spread to a mutable tuple — `pgEnum` wants
 * `[string, ...string[]]`, not a `readonly` array.
 */
export const exitReasonEnum = pgEnum('exit_reason', [...EXIT_REASONS] as [string, ...string[]])
export const errorCodeEnum = pgEnum('error_code', [...ERROR_CODES] as [string, ...string[]])

/** The engine↔venue dimensions the reconciler diffs (`15` §2, 0400); balance deferred to SUGGESTIONS. */
export const reconDimensionEnum = pgEnum('recon_dimension', ['fills', 'position', 'funding'])

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
    /** `00_globals` §10.1, set only on `→ CLOSED`. Typed pg enum (`exitReasonEnum`). */
    exitReason: exitReasonEnum('exit_reason'),
    /** `00_globals` §10.2, set only on terminal error paths. Typed pg enum (`errorCodeEnum`). */
    errorCode: errorCodeEnum('error_code'),
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

/**
 * Order descriptor + current status (`14` §3). The sim/e2e path (bus projector)
 * only knows `client_order_id` + `status`, so the descriptor cols (symbol/side/
 * type/price/qty/reduce_only) are nullable — the live order-manager fills them
 * (deferred; see SUGGESTIONS). Natural key: `client_order_id` (per instance).
 */
export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    /** Deterministic idempotency key `f(intentId, leg, attempt)` (`11` §4). */
    clientOrderId: text('client_order_id').notNull(),
    venueOrderId: text('venue_order_id'),
    symbol: text('symbol'),
    side: text('side'),
    type: text('type'),
    price: doublePrecision('price'),
    qty: doublePrecision('qty'),
    /** Order FSM status (`11` §6); plain text — no producer-side enum today. */
    status: text('status').notNull(),
    reduceOnly: boolean('reduce_only'),
    filledQty: doublePrecision('filled_qty'),
  },
  (table) => [
    uniqueIndex('orders_natural_key').on(table.exchange, table.strategy, table.subaccount, table.clientOrderId),
    index('orders_instance_idx').on(table.exchange, table.strategy, table.subaccount),
  ],
)

/**
 * Append-only fills (`14` §3). No venue trade id on the `OrderUpdate` event, so
 * the natural key is the best available: `(client_order_id, ts, qty)`. A
 * duplicate WS delivery is byte-identical on that key, so `onConflictDoNothing`
 * dedupes it (SUGGESTIONS: add a venue trade id to the fill event when a venue
 * supplies one). `fee_class` is nullable — no fee producer yet.
 */
export const fills = pgTable(
  'fills',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    clientOrderId: text('client_order_id').notNull(),
    /** Fill price, quote currency. */
    px: doublePrecision('px').notNull(),
    /** Fill quantity, base units. */
    qty: doublePrecision('qty').notNull(),
    /** Fill time, epoch ms UTC. */
    ts: bigint('ts', { mode: 'number' }).notNull(),
    /** `maker | taker` fee class (`00_globals` §4); null — no fee producer yet. */
    feeClass: text('fee_class'),
  },
  (table) => [
    uniqueIndex('fills_natural_key').on(
      table.exchange,
      table.strategy,
      table.subaccount,
      table.clientOrderId,
      table.ts,
      table.qty,
    ),
    index('fills_instance_idx').on(table.exchange, table.strategy, table.subaccount),
  ],
)

/** Current position per symbol (`14` §3). Natural key: `symbol` (per instance). */
export const positions = pgTable(
  'positions',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    /** Position size, base units. */
    qty: doublePrecision('qty').notNull(),
    entryPrice: doublePrecision('entry_price'),
    /** Last update time, epoch ms UTC. */
    updatedTs: bigint('updated_ts', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('positions_natural_key').on(table.exchange, table.strategy, table.subaccount, table.symbol),
    index('positions_instance_idx').on(table.exchange, table.strategy, table.subaccount),
  ],
)

/**
 * Funding fees credited/charged (`14` §3). Append-once natural key
 * `(symbol, funding_time)` — a re-delivered `funding_fee` event is a no-op.
 */
export const fundingEvents = pgTable(
  'funding_events',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    symbol: text('symbol').notNull(),
    /** `T_drop`, epoch ms UTC (`00_globals` §1.1). */
    fundingTime: bigint('funding_time', { mode: 'number' }).notNull(),
    /** Funding amount, quote currency; signed (credit +, charge −). */
    amount: doublePrecision('amount').notNull(),
    /** Settled funding rate, signed percent; null when only the fee is known. */
    rate: doublePrecision('rate'),
  },
  (table) => [
    uniqueIndex('funding_events_natural_key').on(
      table.exchange,
      table.strategy,
      table.subaccount,
      table.symbol,
      table.fundingTime,
    ),
    index('funding_events_instance_idx').on(table.exchange, table.strategy, table.subaccount),
  ],
)

/**
 * Per-intent P&L breakdown (`00_globals` §8.3). Table created now; **no writer
 * yet** — the row producer lands with accounting (0390). Natural key: `intent_id`.
 * All value cols nullable until that producer sets them.
 */
export const pnl = pgTable(
  'pnl',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    intentId: text('intent_id').notNull(),
    /** Entry / exit / average fill price (`00_globals` §8.3). */
    pEntry: doublePrecision('p_entry'),
    pExit: doublePrecision('p_exit'),
    pAvg: doublePrecision('p_avg'),
    /** Price-move P&L, quote currency. */
    deltaPnl: doublePrecision('delta_pnl'),
    /** Funding P&L, quote currency. */
    fundingPnl: doublePrecision('funding_pnl'),
    /** Total fee cost, quote currency. */
    feeCost: doublePrecision('fee_cost'),
    /** Net P&L, quote currency. */
    netPnl: doublePrecision('net_pnl'),
    exitReason: exitReasonEnum('exit_reason'),
    errorCode: errorCodeEnum('error_code'),
    /** Hold duration, seconds. */
    holdDurationS: bigint('hold_duration_s', { mode: 'number' }),
    fillCount: bigint('fill_count', { mode: 'number' }),
    fundingReceived: boolean('funding_received'),
    /** `T_drop` offset from `T_settle`, seconds. */
    tDropOffsetS: bigint('t_drop_offset_s', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('pnl_natural_key').on(table.exchange, table.strategy, table.subaccount, table.intentId),
    index('pnl_instance_idx').on(table.exchange, table.strategy, table.subaccount),
  ],
)

/**
 * Current kill-switch state, one row per instance (`13` §2). Natural key: the
 * triple itself.
 */
export const killSwitch = pgTable(
  'kill_switch',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    /** `off | paused | flatten` (`13` §2); plain text. */
    state: text('state').notNull(),
    reason: text('reason'),
    /** Last transition time, epoch ms UTC. */
    updatedTs: bigint('updated_ts', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('kill_switch_natural_key').on(table.exchange, table.strategy, table.subaccount),
    index('kill_switch_instance_idx').on(table.exchange, table.strategy, table.subaccount),
  ],
)

/**
 * Engine-vs-venue reconciliation diffs (`15` §2, task 0400). One row per dimension
 * where the engine's persisted record diverged from venue ground truth. Surrogate id
 * key (an intent/symbol reconciles many times); `engine_value`/`venue_value` are the
 * compared scalars in each dimension's natural unit (fills → fee/price/qty; funding →
 * quote amount; position → base-unit qty).
 */
export const reconciliation = pgTable(
  'reconciliation',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    /** Set for a per-close reconcile; null for a periodic position sweep. */
    intentId: text('intent_id'),
    symbol: text('symbol').notNull(),
    /** Which engine↔venue dimension diverged (`recon_dimension` enum). */
    dimension: reconDimensionEnum('dimension').notNull(),
    /** Engine-side compared scalar (dimension's natural unit). */
    engineValue: doublePrecision('engine_value').notNull(),
    /** Venue-side compared scalar (dimension's natural unit). */
    venueValue: doublePrecision('venue_value').notNull(),
    /** `venue_wins` | `desync` | `in_tolerance` — how the diff was resolved. */
    resolution: text('resolution').notNull(),
    /** Whether the diff was inside the configured tolerance. */
    withinTolerance: boolean('within_tolerance').notNull(),
    /** Reconcile time, epoch ms UTC. */
    ts: bigint('ts', { mode: 'number' }).notNull(),
  },
  (table) => [index('reconciliation_instance_idx').on(table.exchange, table.strategy, table.subaccount)],
)

/**
 * S2 trailing-retracement tracker snapshots (`03_strategy_2.md`). Storage only —
 * the write wiring + boot-respawn stay 0370 (STATUS 0310 note). Natural key:
 * `intent_id`; the `snapshot` jsonb holds a `RetracementSnapshot`.
 */
export const trackerSnapshots = pgTable(
  'tracker_snapshots',
  {
    id: serial('id').primaryKey(),
    exchange: text('exchange').notNull(),
    strategy: text('strategy').notNull(),
    subaccount: text('subaccount').notNull(),
    intentId: text('intent_id').notNull(),
    /** Serialized `RetracementSnapshot` (`src/core/strategies/s2`). */
    snapshot: jsonb('snapshot').notNull(),
    /** Last update time, epoch ms UTC. */
    updatedTs: bigint('updated_ts', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('tracker_snapshots_natural_key').on(table.exchange, table.strategy, table.subaccount, table.intentId),
    index('tracker_snapshots_instance_idx').on(table.exchange, table.strategy, table.subaccount),
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
