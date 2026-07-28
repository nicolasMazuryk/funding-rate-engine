/**
 * `funding-settlement` — hold a real position across a real settlement and prove the venue
 * actually paid it (task 0470 phase 7; `00_globals.md` §1.1 `T_drop`/§6, `11` §9).
 *
 * This is the one thing no earlier tier could do. The sim models funding, the testnet tier can
 * only *read* a funding rate, and `fill-test` is over in seconds — so every venue's funding path
 * has until now been mapped from documentation and never observed. Three of the five mappings
 * were explicitly guesses: OKX's `balance_and_position` delta, Bitget's balance-delta inference,
 * and KuCoin's `position.settlement` **sign** (`src/adapters/CLAUDE.md` quirk table).
 *
 * The settlement itself was chosen by `./funding-window.ts`, which also picked a symbol whose
 * predicted funding is negative and released the entry ~90 s before `T_settle` — so this check
 * usually holds for seconds, not for a funding interval.
 *
 * Two independent witnesses must agree, which is the whole point:
 *
 *  - the **private stream**'s `FundingFeeAccrued` — the hot-path signal the funding gate trades
 *    on (`00_globals.md` §6), and the only place a venue's mapping is ever exercised;
 *  - **`fundingIncome()`** — the REST money truth, the gate's safety net.
 *
 * A missing REST row means the position was not funded at all (wrong window, wrong symbol, or a
 * venue that settles elsewhere). A REST row with no stream event is worse in one specific way:
 * the money moved and the engine would never have seen it. Both fail, and each says which.
 *
 * The **sign** is cross-checked against the settled rate from `fundingHistory()`, since a
 * sign-flipped mapping is otherwise invisible — it reads as a perfectly plausible credit.
 */

import type { FundingFeeAccrued } from '../../core/events/types.js'
import type { FundingIncome } from '../../core/ports/exchange-adapter.js'
import type { LiveContext } from '../context.js'
import { retryOnClock, waitUntil } from '../poll.js'
import type { LiveCheck } from '../registry.js'
import { requirePreflight } from './preflight.js'

/** Poll attempts after `T_settle`, one {@link SETTLEMENT_POLL_MS} apart, for both witnesses. */
const SETTLEMENT_ATTEMPTS = 60
const SETTLEMENT_POLL_MS = 5_000

/**
 * Agreement window between the stream's `fundingTime` and the REST row's (ROADMAP A1). The two
 * come from different venue subsystems and are stamped independently; 5 s is the documented
 * tolerance for calling them the same settlement.
 */
const WITNESS_SKEW_MS = 5_000

/** How far either side of `T_settle` a row still counts as *this* settlement's. */
const SETTLEMENT_MATCH_MS = 120_000

/**
 * The settlement's stream witness, from everything this run recorded. Scoped by `fundingTime`
 * rather than by where the hold started: a venue may publish the accrual while an earlier check
 * is still finishing, and the `settleTs` match already excludes any other settlement.
 */
function findAccrual(ctx: LiveContext, symbol: string, settleTs: number): FundingFeeAccrued | undefined {
  return ctx.events
    .filter((e): e is FundingFeeAccrued => e.type === 'FundingFeeAccrued' && e.symbol === symbol)
    .find((e) => Math.abs(e.fundingTime - settleTs) <= SETTLEMENT_MATCH_MS)
}

/** Sign as `-1 | 0 | 1`; the only part of an amount a mapping can get catastrophically wrong. */
function signOf(value: number): number {
  return Math.sign(value)
}

/**
 * The sign the position should have been paid in (`00_globals.md` §1.1/§3.1): with a negative
 * settled rate a long **receives**, with a positive one it pays. `undefined` when the venue
 * reports no rate for this settlement, or reports exactly zero — neither implies a sign.
 */
async function expectedSign(ctx: LiveContext, symbol: string, settleTs: number): Promise<number | undefined> {
  const history = await ctx.adapter.fundingHistory(symbol, {
    fromTs: settleTs - SETTLEMENT_MATCH_MS,
    toTs: settleTs + SETTLEMENT_MATCH_MS,
  })
  const settled = history.find((e) => Math.abs(e.settleTs - settleTs) <= SETTLEMENT_MATCH_MS)
  if (settled === undefined || settled.rate === 0) return undefined
  // The run only ever holds the long `fill-entry` opened, so the paid sign is `-rate`.
  return signOf(-settled.rate)
}

export const fundingSettlementCheck: LiveCheck = {
  name: 'funding-settlement',
  specRef: '00_globals §6 funding gate / 11 §9',
  async run(ctx: LiveContext) {
    const skip = requirePreflight(ctx)
    if (skip !== undefined) return skip

    const fill = ctx.state.fill
    if (fill === undefined) return { status: 'skip', reason: 'no position to hold across a settlement' }

    // `funding-window` timed the whole run against one boundary and released the entry seconds
    // before it. There is deliberately no fallback to "the next boundary of whatever symbol got
    // filled": that would hold real money for up to a full 8 h interval on a symbol nobody chose
    // for its funding — the exact exposure this suite is shaped to avoid.
    const settleTs = ctx.state.settleTs
    if (settleTs === undefined) {
      return { status: 'skip', reason: 'no settlement was scheduled by funding-window' }
    }
    const { fundingIntervalHours } = ctx.adapter.normalize(fill.symbol)

    await waitUntil(ctx.clock, settleTs, (remainingMs) =>
      ctx.log('holding a live position across the funding settlement', {
        symbol: fill.symbol,
        settleTs,
        remainingSeconds: Math.ceil(remainingMs / 1_000),
      }),
    )

    let accrual: FundingFeeAccrued | undefined
    let income: FundingIncome | undefined
    await retryOnClock(
      ctx.clock,
      async () => {
        accrual ??= findAccrual(ctx, fill.symbol, settleTs)
        income ??= (
          await ctx.adapter.fundingIncome(fill.symbol, {
            fromTs: settleTs - SETTLEMENT_MATCH_MS,
            toTs: ctx.clock.now(),
          })
        ).find((row) => Math.abs(row.fundingTime - settleTs) <= SETTLEMENT_MATCH_MS)
        if (income === undefined) throw new Error('no fundingIncome row for this settlement yet')
        if (accrual === undefined) throw new Error('no FundingFeeAccrued on the private stream yet')
      },
      SETTLEMENT_ATTEMPTS,
      SETTLEMENT_POLL_MS,
    ).catch(() => {
      // Both witnesses are asserted individually below, each with its own diagnosis.
    })

    if (income === undefined) {
      throw new Error(
        `${ctx.venue} reported no fundingIncome row for ${fill.symbol} around the ` +
          `${new Date(settleTs).toISOString()} settlement — the position was held but never funded, ` +
          'or the REST read is looking at the wrong window (00_globals §6)',
      )
    }
    if (accrual === undefined) {
      throw new Error(
        `${ctx.venue} credited ${income.amount} USDT of funding for ${fill.symbol} but its private ` +
          'stream published no FundingFeeAccrued — the money moved and the engine would not have ' +
          "seen it, so this venue's funding mapping is wrong (11 §9)",
      )
    }

    const skewMs = Math.abs(accrual.fundingTime - income.fundingTime)
    if (skewMs > WITNESS_SKEW_MS) {
      throw new Error(
        `the stream and REST witnesses disagree on when ${fill.symbol} funded: ` +
          `${accrual.fundingTime} vs ${income.fundingTime} (${skewMs}ms apart, tolerance ${WITNESS_SKEW_MS}ms)`,
      )
    }
    // Absolute floor for a venue that rounds its stream amount; relative for a real divergence.
    const amountTolerance = Math.max(0.01, Math.abs(income.amount) * 0.01)
    if (
      signOf(accrual.amount) !== signOf(income.amount) ||
      Math.abs(accrual.amount - income.amount) > amountTolerance
    ) {
      throw new Error(
        `the stream and REST witnesses disagree on how much ${fill.symbol} funded: ` +
          `${accrual.amount} vs ${income.amount} USDT`,
      )
    }

    const expected = await expectedSign(ctx, fill.symbol, settleTs)
    if (expected !== undefined && signOf(income.amount) !== expected) {
      throw new Error(
        `${fill.symbol} funding was credited with the wrong sign: got ${income.amount} USDT on a long, ` +
          `expected a ${expected > 0 ? 'credit' : 'charge'} for the settled rate — suspect a sign flip in ` +
          `${ctx.venue}'s funding mapping (00_globals §1.1)`,
      )
    }

    ctx.state.fundingUsd = income.amount
    return {
      status: 'pass',
      detail: {
        symbol: fill.symbol,
        settleTs,
        fundingIntervalHours,
        fundingUsd: income.amount,
        streamAmountUsd: accrual.amount,
        streamFundingTime: accrual.fundingTime,
        restFundingTime: income.fundingTime,
        witnessSkewMs: skewMs,
        signVerified: expected !== undefined,
      },
    }
  },
}
