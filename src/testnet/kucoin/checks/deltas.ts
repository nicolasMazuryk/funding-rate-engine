/**
 * Per-exchange deltas check (`17` §3 bullet 7, `00_globals.md` §6). KuCoin's `exchanges.yaml`
 * profile carries `deltas: {}` — the venue runs the standard defaults, a binding decision of
 * task 0460 — so this asserts the documented defaults are what's actually wired
 * (`wsOrderRestFallback` defaults to `false`, `delta-merge.ts`) and that the venue's submission
 * stagger is the standard 100 ms (Bybit is the outlier at 150).
 *
 * Also exercises the venue's real divergence, read-only: `fundingIncome` is **implemented** off
 * ccxt's `fetchFundingHistory` (`GET /api/v1/funding-history`), whose rows arrive already scoped
 * to funding settlements — no ledger/bill-type filter (Bybit, OKX) and no stub (Binance). It is
 * read over a **historical** 24 h window, because waiting for an in-window settlement would
 * stall the run for up to a funding interval. An empty result is not a failure (an account that
 * held no position across a settlement legitimately has no rows); a malformed row is.
 */

import type { FundingIncome } from '../../../core/ports/exchange-adapter.js'
import type { KucoinLiveContext } from '../../context.js'
import type { Check } from '../../types.js'

/** `00_globals.md` §6 — KuCoin runs the standard 100 ms stagger. */
const EXPECTED_STAGGER_MS = 100
const DAY_MS = 86_400_000

/** The one symbol this suite touches; also the most likely to carry a settlement. */
const SYMBOL = 'BTC'

/** Every row must be this symbol, a finite non-zero amount, and inside the asked window. */
function assertWellFormed(rows: readonly FundingIncome[], fromTs: number, toTs: number): void {
  for (const row of rows) {
    if (row.symbol !== SYMBOL) throw new Error(`fundingIncome returned a foreign symbol '${row.symbol}'`)
    if (!Number.isFinite(row.amount) || row.amount === 0) {
      throw new Error(`fundingIncome row has a non-finite/zero amount: ${JSON.stringify(row)}`)
    }
    if (row.fundingTime < fromTs || row.fundingTime > toTs) {
      throw new Error(`fundingIncome row outside the asked window: ${JSON.stringify(row)}`)
    }
  }
}

export const deltasCheck: Check<KucoinLiveContext> = {
  name: 'deltas',
  specRef: '17 §3 per-exchange deltas',
  async run(ctx) {
    const profile = ctx.profile

    // The rekeyed profile always carries the three delta keys; `undefined` is "not overridden".
    const overridden = Object.entries(profile.deltas)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
    if (overridden.length > 0) {
      throw new Error(`expected KuCoin to ship no deltas (task 0460 decision), got: ${overridden.join(', ')}`)
    }
    const effectiveWsOrderRestFallback = profile.deltas.wsOrderRestFallback ?? false
    if (effectiveWsOrderRestFallback !== false) {
      throw new Error(
        `expected KuCoin's empty deltas to default wsOrderRestFallback to false, got ${effectiveWsOrderRestFallback}`,
      )
    }
    if (profile.submissionStaggerMs !== EXPECTED_STAGGER_MS) {
      throw new Error(
        `expected KuCoin submission_stagger_ms=${EXPECTED_STAGGER_MS} (00_globals §6), got ${profile.submissionStaggerMs}`,
      )
    }

    const base = {
      deltas: profile.deltas,
      effectiveWsOrderRestFallback,
      submissionStaggerMs: profile.submissionStaggerMs,
    }
    if (!ctx.hasCredentials) {
      return { status: 'pass', detail: { ...base, fundingIncome: 'skipped (no credentials)' } }
    }

    // Historical window: the last completed day, never a wait for a future settlement. A read.
    const toTs = ctx.clock.now()
    const fromTs = toTs - DAY_MS
    const rows = await ctx.adapter.fundingIncome(SYMBOL, { fromTs, toTs })
    assertWellFormed(rows, fromTs, toTs)

    return { status: 'pass', detail: { ...base, fundingIncome: { fromTs, toTs, rows: rows.length } } }
  },
}
