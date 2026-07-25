/**
 * Per-exchange deltas check (`17` §3 bullet 7, `00_globals.md` §6). Bybit's
 * `exchanges.yaml` profile carries `deltas: {}` — no overrides — so this asserts the
 * documented defaults are what's actually wired (`wsOrderRestFallback` defaults to `false`,
 * `delta-merge.ts`), plus the one number Bybit really does diverge on: **150 ms
 * `submission_stagger_ms`** (`00_globals.md` §6), threaded into the live order manager by
 * `context.ts` straight off this profile.
 *
 * Also exercises the venue's other real divergence: `fundingIncome` is **implemented** here
 * (transaction log, `type=SETTLEMENT`, `info.funding`, positive = received), where Binance
 * still stubs it. It is read over a **historical** 24 h window — a settlement that already
 * happened — because waiting for an in-window settlement would make the check take up to a
 * funding interval. An empty result is not a failure (a testnet account that held no
 * position across a settlement legitimately has no rows); a malformed row is.
 */

import type { FundingIncome } from '../../../core/ports/exchange-adapter.js'
import type { BybitTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** `00_globals.md` §6 — Bybit serializes submissions at 150 ms. */
const EXPECTED_STAGGER_MS = 150
const DAY_MS = 86_400_000

/** The one symbol this suite touches; also the most likely to carry a testnet settlement. */
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

export const deltasCheck: Check<BybitTestnetContext> = {
  name: 'deltas',
  specRef: '17 §3 per-exchange deltas',
  async run(ctx) {
    const profile = ctx.profile

    const effectiveWsOrderRestFallback = profile.deltas.wsOrderRestFallback ?? false
    if (effectiveWsOrderRestFallback !== false) {
      throw new Error(
        `expected Bybit's empty deltas to default wsOrderRestFallback to false, got ${effectiveWsOrderRestFallback}`,
      )
    }
    if (profile.submissionStaggerMs !== EXPECTED_STAGGER_MS) {
      throw new Error(
        `expected Bybit submission_stagger_ms=${EXPECTED_STAGGER_MS} (00_globals §6), got ${profile.submissionStaggerMs}`,
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

    // Historical window: the last completed day, never a wait for a future settlement.
    const toTs = ctx.clock.now()
    const fromTs = toTs - DAY_MS
    const rows = await ctx.adapter.fundingIncome(SYMBOL, { fromTs, toTs })
    assertWellFormed(rows, fromTs, toTs)

    return { status: 'pass', detail: { ...base, fundingIncome: { fromTs, toTs, rows: rows.length } } }
  },
}
