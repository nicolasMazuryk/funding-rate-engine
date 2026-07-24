/**
 * Post-trade accounting sidecar (`15_accounting_and_reconciliation.md` §1/§3, task
 * 0390) — the edge producer for the `pnl` table.
 *
 * On every terminal `commit` the engine fires {@link EngineDeps.onTradeClose} with a
 * realized-fact {@link TradeCloseContext}. This sidecar reads the venue-settled
 * funding amount from `funding_events` (never `|F|`-derived — `00_globals` §G-R/R7),
 * feeds the pure {@link assembleTradeRecord} assembler, and writes one idempotent
 * `pnl` row. It sits at the edge (may touch the repo, like `projector.ts`) and is
 * fire-and-forget off the hot path — a persistence blip never throws into the engine.
 */

import { assembleTradeRecord, type TradeFacts } from '../core/accounting/trade-record.js'
import type { Repo } from '../core/ports/repo.js'
import type { FeeInputs } from '../core/runtime/cost-model.js'
import type { TradeCloseContext } from '../core/runtime/engine.js'

/** A running sidecar; `onTradeClose` is wired into the engine deps. */
export interface PnlSidecar {
  onTradeClose(ctx: TradeCloseContext): void
}

/**
 * Window (ms) around `T_settle` to match the settled funding event. The venue's
 * `T_drop` is within ±5 s of `T_settle` (`00_globals` §1.1); funding events are ≥1 h
 * apart, so a generous window still resolves to the one drop for this position.
 */
const FUNDING_MATCH_WINDOW_MS = 30 * 60 * 1000

/**
 * Build the sidecar. `fees` is the exchange fee profile (taker/maker percent) the
 * §4 path geometry books against; `repo` is the instance-scoped store. The optional
 * writers (`upsertPnl` / `loadFundingEventsForSymbol`) are absent on the in-memory
 * repo, so tests without Postgres see the sidecar assemble but not persist.
 */
export function createPnlSidecar({ repo, fees }: { readonly repo: Repo; readonly fees: FeeInputs }): PnlSidecar {
  async function book(ctx: TradeCloseContext): Promise<void> {
    // Venue is ground truth for funding (`00_globals` §G-R/R7): book what the venue actually
    // credited/charged, not the timing verdict. A settled event near `T_settle` means funding was
    // received — this is what makes S6 correct: its PRE leg harvests funding across settle, though
    // the MAIN entry lands *after* settle, so the entry-before-settle verdict alone reads false.
    const settled = await loadSettledFunding(ctx)
    const facts: TradeFacts = {
      intentId: ctx.intentId,
      strategyId: ctx.strategyId,
      entrySide: ctx.entrySide,
      exitReason: ctx.exitReason,
      errorCode: ctx.errorCode,
      pEntry: ctx.pEntry,
      pExit: ctx.pExit,
      pAvg: ctx.pAvg,
      entryQty: ctx.entryQty,
      filledQty: ctx.filledQty,
      fillCount: ctx.fillCount,
      settledFundingAmount: settled?.amount ?? 0,
      fundingReceived: settled !== undefined || ctx.fundingReceived,
      enteredAtMs: ctx.enteredAtMs,
      closedAtMs: ctx.closedAtMs,
      tSettleMs: ctx.tSettleMs,
      tDropOffsetS: ctx.tDropOffsetS,
      fees,
      // S6 books the MAIN leg from `pEntry` (the MAIN reversal fill); the PRE leg's fill facts
      // are not threaded from the engine yet, so `PRE_FUNDING_DELTA` books 0 (`07` §2, flagged 0500).
      mainEntryPx: ctx.pEntry,
    }
    await repo.upsertPnl?.(assembleTradeRecord(facts))
  }

  /** The venue-settled funding event (quote ccy, signed) nearest `T_settle` for this intent, or undefined if none. */
  async function loadSettledFunding(ctx: TradeCloseContext): Promise<{ amount: number } | undefined> {
    const tSettleMs = ctx.tSettleMs
    if (tSettleMs === undefined || repo.loadFundingEventsForSymbol === undefined) return undefined
    const events = await repo.loadFundingEventsForSymbol(ctx.symbol, {
      fromMs: tSettleMs - FUNDING_MATCH_WINDOW_MS,
      toMs: tSettleMs + FUNDING_MATCH_WINDOW_MS,
    })
    if (events.length === 0) return undefined
    // The drop nearest `T_settle` is this position's (one accrual per settle per symbol).
    const nearest = events.reduce((best, e) =>
      Math.abs(e.fundingTime - tSettleMs) < Math.abs(best.fundingTime - tSettleMs) ? e : best,
    )
    return { amount: nearest.amount }
  }

  return {
    onTradeClose(ctx: TradeCloseContext): void {
      void book(ctx).catch(swallow)
    },
  }
}

/** Swallow an accounting write error — the sidecar never throws into the hot path (mirrors `projector.ts`). */
function swallow(err: unknown): void {
  console.warn(`[pnl-sidecar] deferring — accounting write failed: ${(err as Error).message}`)
}
