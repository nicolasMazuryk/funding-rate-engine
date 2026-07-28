/**
 * Live-tier **teardown** (task 0470 phase 3) — the promise that a live run always ends flat.
 *
 * Three steps, in order: venue-native cancel sweep (`./sweep.ts` — why not `adapter.cancelOrder`
 * is documented there) → `flattenAll` (reused verbatim from `src/risk/flatten.ts`, so the live
 * tier and the kill switch flatten through the same abort ladder) → a **REST verification** that
 * both positions and open orders are empty. The verdict trusts `verifiedFlat`, never the absence
 * of an error: "we sent the closes" is not "the account is flat".
 *
 * Each step is `try/catch`'d into `errors[]` rather than thrown, because the steps are
 * independent: a cancel sweep that fails must still flatten, and a flatten that fails must still
 * report what the account actually looks like. The three run as a **bounded loop** — see
 * {@link TEARDOWN_ATTEMPTS} for the live-proven race that makes one pass insufficient.
 *
 * Idempotent and re-entrant by memoizing the in-flight promise: the CLI runs teardown from a
 * signal handler *and* from `finally`, and both must not produce two concurrent flatten ladders
 * racing over the same positions. A second `run()` returns the first run's report.
 */

import type { EventBus } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { ExchangeAdapter, Order, Position } from '../core/ports/exchange-adapter.js'
import { waitMs } from '../core/runtime/close-with-retries.js'
import { type FlattenResidual, flattenAll } from '../risk/flatten.js'
import type { CancelSweep } from './sweep.js'

/** The abort-ladder backoffs the kill-switch flatten uses (`00_globals.md` §5.2). */
const DEFAULT_BACKOFFS_MS = [250, 1000, 3000] as const

/**
 * How many times the sweep → flatten → verify sequence runs before the account is called
 * not-flat; it stops early the moment a verification comes back flat. Two, because of a race
 * proven live (0470 §5): a signal can arrive while a check's `placeOrder` is still travelling,
 * so the order reaches the book *after* the sweep read it — the first pass can only report the
 * leftover, the second cancels it.
 */
const TEARDOWN_ATTEMPTS = 2

/**
 * Wait before each verification read, so an order submitted moments earlier has reached the
 * venue's own account-wide view. Load-bearing, not cosmetic: without it Binance returned a
 * **false flat** while the drill's order was really resting (0470 §5), and a false flat ends
 * the loop early. "We read no orders" is evidence of flat only once the book has had time to
 * show one.
 */
const VERIFY_SETTLE_MS = 3000

/** What one teardown did, and — the load-bearing field — whether the account is provably flat. */
export interface TeardownReport {
  /** Why teardown ran (`'suite-end'`, `'SIGINT'`, …) — carried into the verdict. */
  readonly reason: string
  readonly startedAtMs: number
  readonly durationMs: number
  /** Labels of the orders the venue-native sweep cancelled. */
  readonly cancelled: readonly string[]
  /** Symbols `flattenAll` confirmed closed. */
  readonly flattened: readonly string[]
  /** Positions that survived the abort ladder (each also published as `OrphanDetected`). */
  readonly residuals: readonly FlattenResidual[]
  /** Positions still open on the final REST read. */
  readonly openPositions: readonly Position[]
  /** Orders still resting on the final REST read. */
  readonly openOrders: readonly Order[]
  /** True **only** when the final REST read returned no position and no order. */
  readonly verifiedFlat: boolean
  /** One entry per step that threw; a non-empty list does not by itself mean not-flat. */
  readonly errors: readonly string[]
}

export interface Teardown {
  /** Run teardown, or return the report of the run already in flight / already finished. */
  run(reason?: string): Promise<TeardownReport>
}

export interface TeardownDeps {
  readonly exchange: Pick<ExchangeAdapter, 'getPositions' | 'placeOrder' | 'normalize' | 'getOpenOrders'>
  readonly cancelSweep: CancelSweep
  readonly clock: Clock
  readonly bus: EventBus
  /** Override the abort-ladder backoffs (tests); defaults to the kill switch's schedule. */
  readonly backoffsMs?: readonly number[]
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

export function createTeardown(deps: TeardownDeps): Teardown {
  const { exchange, cancelSweep, clock, bus, log } = deps
  const backoffsMs = deps.backoffsMs ?? DEFAULT_BACKOFFS_MS
  let inFlight: Promise<TeardownReport> | undefined

  async function execute(reason: string): Promise<TeardownReport> {
    const startedAtMs = clock.now()
    const errors: string[] = []
    const cancelled: string[] = []
    const flattened: string[] = []
    let residuals: readonly FlattenResidual[] = []
    let openPositions: readonly Position[] = []
    let openOrders: readonly Order[] = []
    let verifiedFlat = false

    for (let attempt = 1; attempt <= TEARDOWN_ATTEMPTS && !verifiedFlat; attempt++) {
      try {
        cancelled.push(...(await cancelSweep()))
      } catch (e) {
        errors.push(`cancel sweep: ${(e as Error).message}`)
      }

      try {
        const result = await flattenAll({ exchange, clock, bus, backoffsMs, ...(log ? { log } : {}) })
        flattened.push(...result.flattened)
        residuals = result.orphans
      } catch (e) {
        errors.push(`flatten: ${(e as Error).message}`)
      }

      // Ground truth. An unreadable account cannot be claimed flat, so a throw here leaves
      // `verifiedFlat` false — the conservative reading, and the one the verdict exits 1 on.
      await waitMs(clock, VERIFY_SETTLE_MS)
      try {
        openPositions = (await exchange.getPositions()).filter((p) => p.qty > 0)
        openOrders = await exchange.getOpenOrders()
        verifiedFlat = openPositions.length === 0 && openOrders.length === 0
      } catch (e) {
        errors.push(`flat verification: ${(e as Error).message}`)
      }
    }

    const report: TeardownReport = {
      reason,
      startedAtMs,
      durationMs: clock.now() - startedAtMs,
      cancelled,
      flattened,
      residuals,
      openPositions,
      openOrders,
      verifiedFlat,
      errors,
    }
    if (!verifiedFlat) {
      log?.('live teardown could not verify the account flat — MANUAL INTERVENTION REQUIRED', {
        reason,
        openPositions,
        openOrders: openOrders.length,
        errors,
      })
    }
    return report
  }

  return {
    run(reason = 'suite-end'): Promise<TeardownReport> {
      // Memoized for the process lifetime: a second call (signal handler, then `finally`)
      // must observe the first run's outcome, not start a competing flatten ladder.
      inFlight ??= execute(reason)
      return inFlight
    },
  }
}
