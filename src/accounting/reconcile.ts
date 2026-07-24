/**
 * Reconciliation sidecar (`15_accounting_and_reconciliation.md` §2/§6, task 0400) — the
 * drift-catcher that closes the loop between the engine's persisted record and venue
 * ground truth. On every intent close and on a periodic sweep it compares the two across
 * dimensions (`15` §2), writes one `reconciliation` diff row per divergence, **corrects
 * money with venue-wins** (fees + funding, re-running the pure {@link assembleTradeRecord}
 * over corrected facts), and alerts beyond tolerance. Position mismatches route to the
 * 0380 orphan/desync machinery ({@link ../core/events/types.js}.OrphanDetected → auto-flatten),
 * never silent correction.
 *
 * **Read-and-record only — no order authority** (`15` §6): it reads `getOrder`/`getPositions`/
 * `fundingIncome` and writes source rows (`funding_events`, corrected `pnl`) + diff rows; it
 * never places an order. It sits at the edge (may touch the repo, like `pnl-sidecar.ts`) and
 * is fire-and-forget off the hot path — a persistence/venue blip never throws into the engine.
 *
 * **Money-correction authority is order-independent**: corrections write the *source* rows
 * (`funding_events`) and overwrite `pnl` via {@link Repo.upsertPnlCorrection}, so the reconciler
 * coexists with the pnl-sidecar (both fire on the same close) and the corrected value wins
 * regardless of which wrote first. **Idempotent** (`15` §2): a second reconcile over an
 * already-corrected intent finds engine == venue ⇒ within tolerance ⇒ writes zero new rows and
 * no pnl change (fee reads back the corrected `pnl.feeCost`; funding reads back the backfilled
 * `funding_events` row).
 */

import { assembleTradeRecord } from '../core/accounting/trade-record.js'
import { makeClientOrderId } from '../core/order-id/client-order-id.js'
import type { EventBus } from '../core/ports/bus.js'
import type { Clock, TimerHandle } from '../core/ports/clock.js'
import type { ExchangeAdapter, Side } from '../core/ports/exchange-adapter.js'
import type { ReconciliationDiffRecord, Repo } from '../core/ports/repo.js'
import type { FeeInputs } from '../core/runtime/cost-model.js'
import type { OpsEvent, TradeCloseContext } from '../core/runtime/engine.js'
import { fromVenueUnits } from '../core/sizing/denomination.js'
import { FUNDING_MATCH_WINDOW_MS, tradeFactsFromClose } from './pnl-sidecar.js'

/** Per-dimension diff tolerances (`15` §2; units per the config `reconcile_*` keys). */
export interface ReconcileTolerances {
  /** Fill-price divergence, percent of the engine price. */
  readonly fillPricePercent: number
  /** Fee divergence, quote USD. */
  readonly feeUsd: number
  /** Funding divergence, quote USD. */
  readonly fundingUsd: number
  /** Position/fill qty divergence, base units. */
  readonly qty: number
}

/** The venue reads + normalize the reconciler needs (a subset of the full adapter port). */
type ReconcileExchange = Pick<ExchangeAdapter, 'getOrder' | 'getPositions' | 'fundingIncome' | 'normalize'>

export interface ReconcilerDeps {
  readonly repo: Repo
  readonly exchange: ReconcileExchange
  /** Publishes `OrphanDetected` on a position desync (routes to the 0380 auto-flatten handler). */
  readonly bus: EventBus
  readonly clock: Clock
  readonly tolerances: ReconcileTolerances
  /** Periodic position-sweep cadence, seconds (`reconcile_sweep_seconds`). */
  readonly sweepSeconds: number
  /** Exchange fee profile — the baseline the engine booked fees against (`15` §3). */
  readonly fees: FeeInputs
  /** Reconcile timestamp source; defaults to `clock.now`. */
  readonly now?: () => number
  /** Beyond-tolerance alert sink — reuses the engine's `OpsEvent` channel (`reconcile.diff_beyond_tolerance`). */
  readonly onOpsEvent?: (event: OpsEvent) => void
}

export interface Reconciler {
  /** Reconcile one just-closed intent across fills/funding/position (`15` §2). Fire-and-forget. */
  onTradeClose(ctx: TradeCloseContext): void
  /** Arm the self-re-arming periodic position sweep. */
  start(): void
  /** Cancel the periodic sweep (SIGTERM teardown). */
  stop(): void
}

/** Below this magnitude two money/qty scalars are treated as equal (float dust, not a diff). */
const EQ_EPS = 1e-9

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const { repo, exchange, bus, clock, tolerances, sweepSeconds, fees } = deps
  const now = deps.now ?? clock.now
  let sweepTimer: TimerHandle | undefined
  let stopped = false

  /** Nearest entry to `t` within the funding match window, or `undefined`. */
  function nearestTo<T extends { readonly time: number }>(rows: readonly T[], t: number): T | undefined {
    const inWindow = rows.filter((r) => Math.abs(r.time - t) <= FUNDING_MATCH_WINDOW_MS)
    if (inWindow.length === 0) return undefined
    return inWindow.reduce((best, r) => (Math.abs(r.time - t) < Math.abs(best.time - t) ? r : best))
  }

  /** Append one diff row (surrogate-id, append-many); a no-diff pass calls this zero times. */
  async function writeDiff(row: Omit<ReconciliationDiffRecord, 'ts'>): Promise<void> {
    await repo.upsertReconciliation?.({ ...row, ts: now() })
  }

  /** Fire the beyond-tolerance alert on the shared ops channel (`reconcile.diff_beyond_tolerance`). */
  function alertBeyond(intentId: string, symbol: string): void {
    deps.onOpsEvent?.({ kind: 'reconcile.diff_beyond_tolerance', intentId, symbol })
  }

  /** The engine's currently-booked funding amount near `T_settle` for this symbol (source-of-truth `funding_events`). */
  async function engineFundingAmount(symbol: string, tSettleMs: number): Promise<number> {
    const events = await repo.loadFundingEventsForSymbol?.(symbol, {
      fromMs: tSettleMs - FUNDING_MATCH_WINDOW_MS,
      toMs: tSettleMs + FUNDING_MATCH_WINDOW_MS,
    })
    const nearest = nearestTo(
      (events ?? []).map((e) => ({ ...e, time: e.fundingTime })),
      tSettleMs,
    )
    return nearest?.amount ?? 0
  }

  /** The venue-credited funding amount near `T_settle` for this symbol (account money truth, R7). */
  async function venueFundingAmount(
    symbol: string,
    tSettleMs: number,
  ): Promise<{ amount: number; time: number } | undefined> {
    const income = await exchange.fundingIncome(symbol, {
      fromTs: tSettleMs - FUNDING_MATCH_WINDOW_MS,
      toTs: tSettleMs + FUNDING_MATCH_WINDOW_MS,
    })
    const nearest = nearestTo(
      income.map((i) => ({ ...i, time: i.fundingTime })),
      tSettleMs,
    )
    return nearest === undefined ? undefined : { amount: nearest.amount, time: nearest.time }
  }

  async function reconcileClose(ctx: TradeCloseContext): Promise<void> {
    const instrument = exchange.normalize(ctx.symbol)
    // The engine's currently-booked money truth (corrected value on a re-reconcile), else the config baseline.
    const persisted = await repo.loadPnl?.(ctx.intentId)
    const baselineFacts = tradeFactsFromClose({ ctx, settledFundingAmount: 0, fundingReceived: false, fees })
    const baselineFeeCost = assembleTradeRecord(baselineFacts).feeCost
    const engineFeeCost = persisted?.feeCost ?? baselineFeeCost

    let feeCostOverride: number | undefined
    let correctedFunding: number | undefined

    // ── Fills dimension: engine booked fill vs `getOrder` price/qty/fee (`15` §2) ──
    const entryCoid = makeClientOrderId({ intentId: ctx.intentId, leg: 'entry', attempt: 1 })
    // A missing order (no venue record for this coid) skips the fills dimension; some adapters throw
    // synchronously (the sim), so a `try` wraps the whole call, not a `.catch` on the promise.
    let venueOrder: Awaited<ReturnType<ReconcileExchange['getOrder']>> | undefined
    try {
      venueOrder = await exchange.getOrder(entryCoid)
    } catch {
      venueOrder = undefined
    }
    if (venueOrder !== undefined) {
      const enginePrice = ctx.pAvg ?? ctx.pEntry
      if (enginePrice !== undefined && venueOrder.fillPx !== undefined && enginePrice > 0) {
        const priceDiff = Math.abs(enginePrice - venueOrder.fillPx)
        if (priceDiff > EQ_EPS) {
          const beyond = (priceDiff / enginePrice) * 100 > tolerances.fillPricePercent
          await writeDiff({
            intentId: ctx.intentId,
            symbol: ctx.symbol,
            dimension: 'fills',
            engineValue: enginePrice,
            venueValue: venueOrder.fillPx,
            resolution: 'venue_wins',
            withinTolerance: !beyond,
          })
          if (beyond) alertBeyond(ctx.intentId, ctx.symbol)
        }
      }

      const engineQty = ctx.filledQty ?? ctx.entryQty
      const venueQty = fromVenueUnits(venueOrder.qty ?? 0, instrument)
      const qtyDiff = Math.abs(engineQty - venueQty)
      if (qtyDiff > EQ_EPS) {
        const beyond = qtyDiff > tolerances.qty
        await writeDiff({
          intentId: ctx.intentId,
          symbol: ctx.symbol,
          dimension: 'fills',
          engineValue: engineQty,
          venueValue: venueQty,
          resolution: 'venue_wins',
          withinTolerance: !beyond,
        })
        if (beyond) alertBeyond(ctx.intentId, ctx.symbol)
      }

      if (venueOrder.fee !== undefined) {
        const feeDiff = Math.abs(engineFeeCost - venueOrder.fee)
        if (feeDiff > EQ_EPS) {
          const beyond = feeDiff > tolerances.feeUsd
          feeCostOverride = venueOrder.fee // venue is truth for money — correct the booked fee
          await writeDiff({
            intentId: ctx.intentId,
            symbol: ctx.symbol,
            dimension: 'fills',
            engineValue: engineFeeCost,
            venueValue: venueOrder.fee,
            resolution: 'venue_wins',
            withinTolerance: !beyond,
          })
          if (beyond) alertBeyond(ctx.intentId, ctx.symbol)
        }
      }
    }

    // ── Funding dimension: engine `funding_events` vs venue `fundingIncome` (money, R7) ──
    if (ctx.tSettleMs !== undefined) {
      const engineFunding = await engineFundingAmount(ctx.symbol, ctx.tSettleMs)
      const venue = await venueFundingAmount(ctx.symbol, ctx.tSettleMs)
      const venueFunding = venue?.amount ?? 0
      if (Math.abs(engineFunding - venueFunding) > EQ_EPS) {
        const beyond = Math.abs(engineFunding - venueFunding) > tolerances.fundingUsd
        // Venue shows an accrual the engine missed → backfill the source-of-truth row, then re-derive pnl.
        if (venue !== undefined && Math.abs(engineFunding) <= EQ_EPS) {
          await repo.upsertFundingEvent?.({ symbol: ctx.symbol, fundingTime: venue.time, amount: venue.amount })
        }
        correctedFunding = venueFunding
        await writeDiff({
          intentId: ctx.intentId,
          symbol: ctx.symbol,
          dimension: 'funding',
          engineValue: engineFunding,
          venueValue: venueFunding,
          resolution: 'venue_wins',
          withinTolerance: !beyond,
        })
        if (beyond) alertBeyond(ctx.intentId, ctx.symbol)
      }
    }

    // ── Re-assemble the corrected pnl ONCE if any money dimension diverged (`15` §2) ──
    if (feeCostOverride !== undefined || correctedFunding !== undefined) {
      const settledFundingAmount = correctedFunding ?? persisted?.fundingPnl ?? 0
      const facts = tradeFactsFromClose({
        ctx,
        settledFundingAmount,
        fundingReceived: settledFundingAmount !== 0 || ctx.fundingReceived,
        fees,
        feeCostOverride,
      })
      await repo.upsertPnlCorrection?.(assembleTradeRecord(facts))
    }

    // ── Position dimension: the just-closed intent expects `ctx.symbol` flat at venue (`13` §5) ──
    await reconcilePosition(ctx.intentId, ctx.symbol)
  }

  /** Compare the engine's expected-flat (closed) position for `symbol` against venue REST ground truth. */
  async function reconcilePosition(intentId: string, symbol: string): Promise<void> {
    const instrument = exchange.normalize(symbol)
    const venuePos = (await exchange.getPositions()).find((p) => p.symbol === symbol)
    const venueQty = venuePos === undefined ? 0 : fromVenueUnits(venuePos.qty, instrument)
    if (venueQty <= tolerances.qty) return // engine (closed) and venue agree: flat
    // Desync: a venue position with no owning (live) intent → route to 0380 auto-flatten, do NOT correct pnl.
    publishOrphan(symbol, venuePos?.side ?? 'long', venuePos?.qty ?? venueQty)
    await writeDiff({
      intentId,
      symbol,
      dimension: 'position',
      engineValue: 0,
      venueValue: venueQty,
      resolution: 'desync',
      withinTolerance: false,
    })
  }

  function publishOrphan(symbol: string, side: Side, qty: number): void {
    bus.publish({ type: 'OrphanDetected', symbol, qty, side })
  }

  /** Periodic sweep: reconcile every persisted engine position against venue REST ground truth. */
  async function sweep(): Promise<void> {
    const enginePositions = (await repo.loadPositions?.()) ?? []
    const venuePositions = await exchange.getPositions()
    const symbols = new Set<string>([...enginePositions.map((p) => p.symbol), ...venuePositions.map((p) => p.symbol)])
    for (const symbol of symbols) {
      const instrument = exchange.normalize(symbol)
      const engineQty = enginePositions.find((p) => p.symbol === symbol)?.qty ?? 0
      const venuePos = venuePositions.find((p) => p.symbol === symbol)
      const venueQty = venuePos === undefined ? 0 : fromVenueUnits(venuePos.qty, instrument)
      if (Math.abs(engineQty - venueQty) <= tolerances.qty) continue
      // Venue holds a position the engine doesn't (fully) know → orphan/desync; engine-only excess just records.
      if (venueQty - engineQty > tolerances.qty && venuePos !== undefined) {
        publishOrphan(symbol, venuePos.side, venuePos.qty)
      }
      await writeDiff({
        symbol,
        dimension: 'position',
        engineValue: engineQty,
        venueValue: venueQty,
        resolution: 'desync',
        withinTolerance: false,
      })
    }
  }

  function armSweep(): void {
    if (stopped) return
    sweepTimer = clock.scheduleTimer(now() + sweepSeconds * 1000, () => {
      void sweep()
        .catch(swallow)
        .finally(() => armSweep()) // self-re-arm (position-tracker idiom), regardless of outcome
    })
  }

  return {
    onTradeClose(ctx: TradeCloseContext): void {
      void reconcileClose(ctx).catch(swallow)
    },
    start(): void {
      stopped = false
      armSweep()
    },
    stop(): void {
      stopped = true
      sweepTimer?.cancel()
    },
  }
}

/** Swallow a reconcile error — the sidecar never throws into the hot path (mirrors `pnl-sidecar.ts`). */
function swallow(err: unknown): void {
  console.warn(`[reconcile] deferring — reconciliation failed: ${(err as Error).message}`)
}
