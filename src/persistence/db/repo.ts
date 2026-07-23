/**
 * Postgres `Repo` implementation (`14` §3, §7) — tier 2 of persistence.
 *
 * Implements the `Repo` port from `src/core/ports/`; the pure core never sees
 * Drizzle or `pg`. Every query is scoped to the closed-over instance triple so
 * instances stay isolated inside the one fleet-wide database (`14` §3).
 */

import { and, notInArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { TERMINAL_INTENT_STATES } from '../../core/intent/intent-machine.js'
import type {
  FillRecord,
  FundingEventRecord,
  IntentSnapshot,
  KillSwitchRecord,
  OrderDescriptor,
  OrderStatusUpdate,
  PositionRecord,
  Repo,
  TrackerSnapshotRecord,
} from '../../core/ports/index.js'
import type { Instance } from './instance.js'
import {
  fills,
  fundingEvents,
  instanceWhere,
  intents,
  killSwitch,
  orders,
  positions,
  trackerSnapshots,
} from './schema.js'

/** Build a `Repo` backed by `pool`, scoped to `instance`. */
export function createPgRepo({ pool, instance }: { readonly pool: Pool; readonly instance: Instance }): Repo {
  const db = drizzle(pool)
  /** The instance triple every row carries (`14` §3). */
  const triple = { exchange: instance.exchange, strategy: instance.strategy, subaccount: instance.subaccount }

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
        .where(and(instanceWhere(intents, instance), notInArray(intents.state, [...TERMINAL_INTENT_STATES])))
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

    async upsertOrderStatus(update: OrderStatusUpdate): Promise<void> {
      await db
        .insert(orders)
        .values({ ...triple, clientOrderId: update.clientOrderId, status: update.status, ...descriptorCols(update) })
        .onConflictDoUpdate({
          target: [orders.exchange, orders.strategy, orders.subaccount, orders.clientOrderId],
          set: { status: update.status, ...descriptorCols(update) },
        })
    },

    async insertFill(fill: FillRecord): Promise<void> {
      await db
        .insert(fills)
        .values({
          ...triple,
          clientOrderId: fill.clientOrderId,
          px: fill.px,
          qty: fill.qty,
          ts: fill.ts,
          feeClass: fill.feeClass ?? null,
        })
        .onConflictDoNothing({
          target: [fills.exchange, fills.strategy, fills.subaccount, fills.clientOrderId, fills.ts, fills.qty],
        })
    },

    async upsertOrder(order: OrderDescriptor): Promise<void> {
      const cols = {
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        qty: order.qty,
        price: order.price ?? null,
        reduceOnly: order.reduceOnly ?? null,
        venueOrderId: order.venueOrderId ?? null,
      }
      await db
        .insert(orders)
        .values({ ...triple, clientOrderId: order.clientOrderId, status: order.status ?? 'NEW', ...cols })
        .onConflictDoUpdate({
          target: [orders.exchange, orders.strategy, orders.subaccount, orders.clientOrderId],
          set: cols,
        })
    },

    async upsertPosition(position: PositionRecord): Promise<void> {
      const cols = {
        side: position.side,
        qty: position.qty,
        entryPrice: position.entryPrice ?? null,
        updatedTs: position.updatedTs,
      }
      await db
        .insert(positions)
        .values({ ...triple, symbol: position.symbol, ...cols })
        .onConflictDoUpdate({
          target: [positions.exchange, positions.strategy, positions.subaccount, positions.symbol],
          set: cols,
        })
    },

    async upsertFundingEvent(event: FundingEventRecord): Promise<void> {
      await db
        .insert(fundingEvents)
        .values({
          ...triple,
          symbol: event.symbol,
          fundingTime: event.fundingTime,
          amount: event.amount,
          rate: event.rate ?? null,
        })
        .onConflictDoNothing({
          target: [
            fundingEvents.exchange,
            fundingEvents.strategy,
            fundingEvents.subaccount,
            fundingEvents.symbol,
            fundingEvents.fundingTime,
          ],
        })
    },

    async upsertKillSwitch(record: KillSwitchRecord): Promise<void> {
      const cols = { state: record.state, reason: record.reason ?? null, updatedTs: record.updatedTs }
      await db
        .insert(killSwitch)
        .values({ ...triple, ...cols })
        .onConflictDoUpdate({
          target: [killSwitch.exchange, killSwitch.strategy, killSwitch.subaccount],
          set: cols,
        })
    },

    async loadKillSwitch(): Promise<KillSwitchRecord | undefined> {
      const [row] = await db.select().from(killSwitch).where(instanceWhere(killSwitch, instance)).limit(1)
      if (row === undefined) return undefined
      return { state: row.state, reason: row.reason ?? undefined, updatedTs: row.updatedTs }
    },

    async upsertTrackerSnapshot(snapshot: TrackerSnapshotRecord): Promise<void> {
      const cols = { snapshot: snapshot.snapshot, updatedTs: snapshot.updatedTs }
      await db
        .insert(trackerSnapshots)
        .values({ ...triple, intentId: snapshot.intentId, ...cols })
        .onConflictDoUpdate({
          target: [
            trackerSnapshots.exchange,
            trackerSnapshots.strategy,
            trackerSnapshots.subaccount,
            trackerSnapshots.intentId,
          ],
          set: cols,
        })
    },

    async loadTrackerSnapshots(): Promise<readonly TrackerSnapshotRecord[]> {
      const rows = await db.select().from(trackerSnapshots).where(instanceWhere(trackerSnapshots, instance))
      return rows.map((r) => ({ intentId: r.intentId, snapshot: r.snapshot, updatedTs: r.updatedTs }))
    },
  }
}

/** Descriptor cols an `OrderStatusUpdate` can carry (only `filledQty`/`venueOrderId` today). */
function descriptorCols(update: OrderStatusUpdate): { filledQty?: number; venueOrderId?: string } {
  const cols: { filledQty?: number; venueOrderId?: string } = {}
  if (update.filledQty !== undefined) cols.filledQty = update.filledQty
  if (update.venueOrderId !== undefined) cols.venueOrderId = update.venueOrderId
  return cols
}
