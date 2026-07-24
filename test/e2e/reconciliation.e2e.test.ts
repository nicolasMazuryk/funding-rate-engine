/**
 * E2E tier (task 0400; `17` §4) — the reconciler sidecar through the **real Postgres**
 * repo (`createPgRepo`) + the generalized `reconciliation` table (migration 0002), on the
 * virtual clock + sim venue. Proves the pg-repo money-correction path the scenario tier
 * exercises against a spy repo:
 *
 *  - a fee divergence writes one `venue_wins` `reconciliation` row (per-dimension shape);
 *  - the `pnl` row is corrected to the venue fee via `upsertPnlCorrection` (overwrite);
 *  - a second reconcile reads back the corrected `pnl.feeCost` → zero new rows (idempotency).
 *
 * Needs Docker Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 */

import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReconciler } from '../../src/accounting/reconcile.js'
import { createVirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createSimExchange } from '../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../src/core/events/bus.js'
import { makeClientOrderId } from '../../src/core/order-id/client-order-id.js'
import type { TradeCloseContext } from '../../src/core/runtime/engine.js'
import { DEV_INSTANCE } from '../../src/persistence/db/instance.js'
import { createPgRepo } from '../../src/persistence/db/repo.js'
import { createE2eContext, E2E_FEES, type E2eContext } from './harness.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://funding:funding@localhost:5432/funding_drop'
const INTENT = 'BTC-4000'
const ENTRY_COID = makeClientOrderId({ intentId: INTENT, leg: 'entry', attempt: 1 })

let ctx: E2eContext

beforeAll(async () => {
  ctx = await createE2eContext()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

function closeCtx(): TradeCloseContext {
  return {
    intentId: INTENT,
    symbol: 'BTC',
    strategyId: 's1',
    entrySide: 'long',
    exitReason: 'timed',
    pEntry: 60_000,
    pExit: 60_000,
    entryQty: 0.001,
    filledQty: 0.001,
    fillCount: 1,
    fundingReceived: false,
    closedAtMs: 300_000,
    tSettleMs: undefined, // funding dimension skipped — this test isolates the fee dimension
  }
}

describe('reconciliation end-to-end through the real Postgres repo', () => {
  it('fee divergence: writes one venue_wins row, corrects pnl, and is idempotent', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 })
    try {
      const repo = createPgRepo({ pool, instance: DEV_INSTANCE })
      const clock = createVirtualClock(0)
      const bus = createEventBus()
      const sim = createSimExchange(clock, bus)
      sim.setPrice('BTC', 60_000)
      await sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: ENTRY_COID })
      sim.setPosition('BTC', 'long', 0) // isolate the fills dimension from a position diff

      const reconciler = createReconciler({
        repo,
        exchange: sim,
        bus,
        clock,
        // Engine s1 fee = 2 × 0.05% × 60 = 0.06; venue (sim default) = 0.04% × 60 = 0.024 → within 0.05.
        tolerances: { fillPricePercent: 0.05, feeUsd: 0.05, fundingUsd: 0.01, qty: 1e-6 },
        sweepSeconds: 300,
        fees: E2E_FEES,
        now: clock.now,
      })

      reconciler.onTradeClose(closeCtx())

      // The corrected pnl row lands (feeCost = venue fee 0.024).
      await vi.waitFor(
        async () => {
          const { rows } = await pool.query('SELECT fee_cost FROM pnl WHERE intent_id = $1', [INTENT])
          expect(rows[0]?.fee_cost).toBeCloseTo(0.024, 6)
        },
        { timeout: 5000, interval: 25 },
      )

      const diff = await pool.query('SELECT * FROM reconciliation WHERE intent_id = $1 AND dimension = $2', [
        INTENT,
        'fills',
      ])
      expect(diff.rows).toHaveLength(1)
      expect(diff.rows[0]).toMatchObject({ resolution: 'venue_wins', within_tolerance: true })
      expect(diff.rows[0].venue_value).toBeCloseTo(0.024, 6)

      // Idempotency: a second reconcile reads back the corrected fee → no new diff row.
      reconciler.onTradeClose(closeCtx())
      // Drain the second pass's DB round-trips (each query yields to the event loop).
      for (let i = 0; i < 15; i++) await pool.query('SELECT 1')
      const after = await pool.query('SELECT count(*)::int AS c FROM reconciliation WHERE intent_id = $1', [INTENT])
      expect(after.rows[0].c).toBe(1)
    } finally {
      await pool.end()
    }
  })
})
