/**
 * Unit: the `funding-test` suite (task 0470 phase 7) driven end to end against the sim venue.
 *
 * The live runs of this suite spend real money on a real settlement, so everything that can be
 * pinned without a venue is pinned here, on the virtual clock:
 *
 *  - the boundary is the next **1 h** grid point, and the symbol is chosen on **negative
 *    predicted funding**, not on price — the whole reason the suite is runnable on demand;
 *  - the entry is released only in the last few minutes, so the position's real-money lifetime is
 *    seconds, and the five venues can share one boundary concurrently;
 *  - the position is **still open** when the settlement lands (holding it is the point);
 *  - both witnesses — the private stream's `FundingFeeAccrued` and the REST `fundingIncome()`
 *    row — are required, and a venue that credits without publishing fails with the message
 *    that names the mapping gap;
 *  - the funding is recorded as funding, not as a fee, so it never eats the suite's fee bound;
 *  - the suite still ends verified flat.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../../src/adapters/sim/sim-exchange.js'
import type { ExchangeProfile } from '../../../src/config/exchange-schema.js'
import type { SubaccountRow } from '../../../src/config/subaccounts.js'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { EngineEvent } from '../../../src/core/events/types.js'
import { resolveCaps } from '../../../src/live/caps.js'
import { fundingWindowCheck, nextBoundaryMs } from '../../../src/live/checks/funding-window.js'
import { preflightCheck } from '../../../src/live/checks/preflight.js'
import type { LiveContext } from '../../../src/live/context.js'
import { LIVE_FUNDING_TARGET_NOTIONAL_USD } from '../../../src/live/funding-pick.js'
import { withNotionalCap } from '../../../src/live/notional-cap.js'
import { LIVE_SUITE_CHECKS, type LiveCheck } from '../../../src/live/registry.js'
import { createTeardown } from '../../../src/live/teardown.js'
import { runChecks } from '../../../src/testnet/runner.js'
import type { TestnetSummary } from '../../../src/testnet/types.js'

const HOUR_MS = 3_600_000
/** Mid-hour, so the run has the full preparation lead to the next 1 h boundary. */
const START_MS = 1_700_000_000_000 - (1_700_000_000_000 % HOUR_MS) + 20 * 60_000
const SETTLE_TS = nextBoundaryMs(START_MS, 1)

const ETH_PRICE = 2_000
/** Where `funding-test` submits: 2 % through last, tick-rounded — the marketable entry. */
const ETH_MARKETABLE_PRICE = 2_040
/** Signed percent (`00_globals.md` §1.1): negative funding ⇒ the long **receives**. */
const ETH_RATE_PERCENT = -0.05
/** Also 1 h and also negative, but less so — the picker must prefer ETH over it. */
const PEPE_RATE_PERCENT = -0.02
/**
 * The most negative of the three, and irrelevant: BTC keeps the venue's 8 h cadence, and the
 * targeted boundary is not on the 8 h grid, so it never settles there and is never even rate-read.
 */
const BTC_RATE_PERCENT = -0.5

const SUBACCOUNT: SubaccountRow = {
  exchange: 'binance',
  strategy: 's6',
  subAccountId: '1',
  subAccountLabel: 'LiveTestSub',
  allocatedCapitalUsdt: 10_000,
  status: 'active',
}

interface Harness {
  readonly clock: VirtualClock
  readonly sim: SimExchange
  readonly ctx: Omit<LiveContext, 'onCleanup'>
  readonly events: readonly EngineEvent[]
}

/**
 * `lastPrice` readings to serve in order, falling back to the real map once exhausted. A too-low
 * reading makes the marketable limit land *below* the book, so the order rests instead of
 * filling — the thin-spread case that cost OKX its settlement live.
 */
function harness(startMs: number = START_MS, staleEthPrices: readonly number[] = []): Harness {
  const clock = createVirtualClock(startMs)
  const bus = createEventBus()
  const sim = createSimExchange(clock, bus)
  const prices = new Map<string, number>([
    ['BTC', 100_000],
    ['ETH', ETH_PRICE],
    ['PEPE', 0.01],
  ])
  for (const [symbol, px] of prices) sim.setPrice(symbol, px)
  // ETH and PEPE settle hourly and pay a long; BTC pays far more but only every 8 h.
  sim.setFundingInterval('ETH', 1)
  sim.setFundingInterval('PEPE', 1)
  sim.setPredictedFunding('ETH', ETH_RATE_PERCENT)
  sim.setPredictedFunding('PEPE', PEPE_RATE_PERCENT)
  sim.setPredictedFunding('BTC', BTC_RATE_PERCENT)

  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))
  const adapter = withNotionalCap(sim, { caps: resolveCaps(), bus, clock })
  let ethPriceReads = 0

  const ctx: Omit<LiveContext, 'onCleanup'> = {
    hasCredentials: true,
    venue: 'binance',
    suite: 'funding-test',
    adapter,
    clock,
    bus,
    events,
    profile: {} as ExchangeProfile,
    subaccount: SUBACCOUNT,
    caps: resolveCaps(),
    teardown: createTeardown({ exchange: adapter, cancelSweep: () => Promise.resolve([]), clock, bus }),
    state: { feesUsd: 0 },
    tracePath: 'test/live/unit.trace.jsonl',
    log: () => {},
    lastPrice: (symbol: string) => {
      const stale = symbol === 'ETH' ? staleEthPrices[ethPriceReads++] : undefined
      return Promise.resolve(stale ?? (prices.get(symbol) as number))
    },
    close: () => Promise.resolve(),
  }
  return { clock, sim, ctx, events }
}

interface RunOptions {
  /** Drop the settlement's `FundingFeeAccrued` — the "credited but never published" venue. */
  readonly dropAccrual?: boolean
  /** Observe the account at `T_settle`; used to assert the position was really held across it. */
  readonly onSettle?: (h: Harness) => void
}

/**
 * Drive the suite to completion, settling funding once the virtual clock reaches the boundary.
 *
 * The step is coarse while the run is only waiting and drops to one second inside the last two
 * minutes. Both halves matter: a uniformly fine step would need thousands of turns to cross the
 * 20-minute wait, and a uniformly coarse one would let the entry sequence itself consume the
 * whole 90-second lead, so the position would be opened *after* the settlement it is meant to
 * be held across — which is exactly the bug this suite exists to catch on a venue.
 */
async function runSuite(h: Harness, opts: RunOptions = {}): Promise<TestnetSummary> {
  const promise = runChecks('binance', '1', LIVE_SUITE_CHECKS['funding-test'], h.ctx, {
    now: () => h.clock.now(),
    network: 'prod',
  })
  let done = false
  void promise.then(() => {
    done = true
  })
  let settled = false
  for (let i = 0; i < 1_500 && !done; i++) {
    await Promise.resolve()
    if (!settled && h.clock.now() >= SETTLE_TS) {
      settled = true
      opts.onSettle?.(h)
      if (opts.dropAccrual === true) h.sim.dropFundingFee()
      h.sim.settleFunding('ETH', ETH_RATE_PERCENT, SETTLE_TS)
    }
    h.sim.setPrice('ETH', ETH_PRICE)
    h.clock.advanceBy(Math.abs(SETTLE_TS - h.clock.now()) <= 2 * 60_000 ? 1_000 : 30_000)
  }
  return promise
}

/** Advance the virtual clock until `checks` finish — no settlement, no orders beyond their own. */
async function settleUntil(h: Harness, checks: readonly LiveCheck[], boundaryMs: number): Promise<TestnetSummary> {
  const promise = runChecks('binance', '1', checks, h.ctx, { now: () => h.clock.now(), network: 'prod' })
  let done = false
  void promise.then(() => {
    done = true
  })
  for (let i = 0; i < 1_500 && !done; i++) {
    await Promise.resolve()
    h.clock.advanceBy(Math.abs(boundaryMs - h.clock.now()) <= 2 * 60_000 ? 1_000 : 30_000)
  }
  return promise
}

describe('nextBoundaryMs (0470 phase 7)', () => {
  it('returns the next UTC-aligned boundary of the interval, strictly in the future', () => {
    expect(nextBoundaryMs(0, 1)).toBe(HOUR_MS)
    expect(nextBoundaryMs(HOUR_MS - 1, 1)).toBe(HOUR_MS)
    // Exactly on a boundary is *this* settlement, already gone — the next one is the one to hold for.
    expect(nextBoundaryMs(HOUR_MS, 1)).toBe(2 * HOUR_MS)
    expect(nextBoundaryMs(90 * 60_000, 4)).toBe(4 * HOUR_MS)
    expect(nextBoundaryMs(90 * 60_000, 8)).toBe(8 * HOUR_MS)
  })
})

describe('live funding-test suite (0470 phase 7)', () => {
  it('picks a short-interval symbol paying a long, holds it across the settlement, closes flat', async () => {
    const h = harness()

    const summary = await runSuite(h)

    expect(summary.results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'subaccount-preflight:pass',
      'funding-window:pass',
      'fill-entry:pass',
      'position-tracking:pass',
      'funding-settlement:pass',
      'reduce-only-close:pass',
      'assert-flat:pass',
    ])
    expect(h.ctx.state.teardown?.verifiedFlat).toBe(true)
    expect(await h.sim.getPositions()).toEqual([])
  })

  it('ranks on funding rate, not on price, and ignores the long-interval symbol whatever it pays', async () => {
    const h = harness()

    const summary = await runSuite(h)

    // BTC is by far the most negative but settles every 8 h; PEPE is 1 h but pays less than ETH.
    expect(h.ctx.state.symbol?.symbol).toBe('ETH')
    expect(summary.results.find((r) => r.name === 'funding-window')?.detail).toMatchObject({
      settleTs: SETTLE_TS,
      symbol: 'ETH',
      ratePercent: ETH_RATE_PERCENT,
      // BTC is filtered out on interval before it costs a rate read at all.
      scannedSymbols: 2,
      qualifyingSymbols: 2,
    })
  })

  it('sizes near the cap rather than at the venue minimum, so the credit clears venue rounding', async () => {
    const h = harness()

    await runSuite(h)

    const pick = h.ctx.state.symbol
    expect(pick?.notionalUsd).toBeGreaterThan(LIVE_FUNDING_TARGET_NOTIONAL_USD * 0.9)
    expect(pick?.notionalUsd).toBeLessThanOrEqual(resolveCaps().maxOrderNotionalUsd)
    expect(h.ctx.adapter.cap.rejections).toEqual([])
  })

  it('opens the position only inside the entry window and still holds it at T_settle', async () => {
    const h = harness()
    let heldAtSettlement: number | undefined
    const fills: number[] = []
    h.ctx.bus.subscribe((e) => {
      if (e.type === 'OrderUpdate' && e.status === 'FILLED') fills.push(h.clock.now())
    })

    await runSuite(h, {
      onSettle: (atSettle) => {
        heldAtSettlement = atSettle.ctx.state.fill?.qty
      },
    })

    expect(heldAtSettlement).toBeGreaterThan(0)
    const entryAt = fills[0] as number
    // The entry lead is the position's whole real-money lifetime — minutes, not the hours a
    // naive "hold until the next settlement" would cost.
    expect(SETTLE_TS - entryAt).toBeLessThanOrEqual(180_000)
    expect(SETTLE_TS - entryAt).toBeGreaterThan(0)
  })

  it('reports the signed funding the venue paid the long, as funding and not as a fee', async () => {
    const h = harness()

    const summary = await runSuite(h)

    const qty = h.ctx.state.fill?.qty as number
    // Negative rate ⇒ the long receives |F| of the position's notional at the mark.
    expect(h.ctx.state.fundingUsd).toBeCloseTo((qty * ETH_PRICE * -ETH_RATE_PERCENT) / 100, 10)
    expect(h.ctx.state.fundingUsd as number).toBeGreaterThan(0)
    expect(summary.results.find((r) => r.name === 'funding-settlement')?.detail).toMatchObject({
      symbol: 'ETH',
      settleTs: SETTLE_TS,
      fundingIntervalHours: 1,
      witnessSkewMs: 0,
      signVerified: true,
    })
    // Funding is not a fee: only the entry+exit taker fees count against the suite bound.
    expect(h.ctx.state.feesUsd).toBeCloseTo((ETH_MARKETABLE_PRICE + ETH_PRICE) * qty * 0.0004, 8)
  })

  it('widens to longer cadences when the boundary is on their grid too', async () => {
    // 20 minutes before an 8 h-aligned hour: the 1 h, 2 h, 4 h and 8 h universes all settle there.
    const alignedSettle = Math.ceil(START_MS / (8 * HOUR_MS)) * 8 * HOUR_MS
    const h = harness(alignedSettle - 20 * 60_000)
    // PEPE back on the venue's 8 h default, and paying far more than the 1 h ETH.
    h.sim.setFundingInterval('PEPE', 8)
    h.sim.setPredictedFunding('PEPE', -0.4)

    const summary = await settleUntil(h, [preflightCheck, fundingWindowCheck], alignedSettle)

    // Without the widening this venue would have exactly one candidate; OKX would have none at
    // all, since it lists no 1 h symbols — which is why the rule is "the grid contains the
    // boundary", not "the interval is one hour".
    expect(summary.results.find((r) => r.name === 'funding-window')?.detail).toMatchObject({
      symbol: 'PEPE',
      ratePercent: -0.4,
      eligibleSymbols: 3,
    })
  })

  it('crosses deeper when the first attempt rests instead of filling', async () => {
    // One stale reading — half the real price — is what the window prices the pick from, so the
    // first marketable limit lands under the book and rests. The retry re-reads and gets truth.
    const h = harness(START_MS, [ETH_PRICE / 2])

    const summary = await runSuite(h)

    expect(summary.results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'subaccount-preflight:pass',
      'funding-window:pass',
      'fill-entry:pass',
      'position-tracking:pass',
      'funding-settlement:pass',
      'reduce-only-close:pass',
      'assert-flat:pass',
    ])
    // Filled on the second rung — 5 % through the re-read last, not 2 % through a stale one.
    expect(summary.results.find((r) => r.name === 'fill-entry')?.detail).toMatchObject({
      limitPrice: ETH_PRICE * 1.05,
      entryAttempts: 2,
    })
    // The abandoned first order is cancelled, not left resting alongside the fill.
    expect(await h.sim.getOpenOrders()).toEqual([])
    expect(h.ctx.state.teardown?.verifiedFlat).toBe(true)
  })

  it("targets the venue's own shortest cadence, not a 1 h boundary it lists nothing on", async () => {
    // The OKX shape: no 1 h symbols anywhere on the venue. Targeting the next 1 h boundary would
    // find an empty universe — nothing on this venue settles then (observed live, 0470 §7).
    const alignedSettle = Math.ceil(START_MS / (4 * HOUR_MS)) * 4 * HOUR_MS
    const h = harness(alignedSettle - 20 * 60_000)
    for (const symbol of ['ETH', 'PEPE', 'BTC']) h.sim.setFundingInterval(symbol, 4)

    const summary = await settleUntil(h, [preflightCheck, fundingWindowCheck], alignedSettle)

    expect(summary.results.find((r) => r.name === 'funding-window')?.detail).toMatchObject({
      cadenceHours: 4,
      settleTs: alignedSettle,
      symbol: 'ETH',
    })
  })

  it('trades nothing at all when no symbol qualifies, rather than holding an unchosen one', async () => {
    const h = harness()
    // Every 1 h symbol now pays a short, so the window has nothing to pick.
    h.sim.setPredictedFunding('ETH', 0.05)
    h.sim.setPredictedFunding('PEPE', 0.02)

    const summary = await runSuite(h)

    expect(summary.results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'subaccount-preflight:pass',
      'funding-window:fail',
      // The dangerous fallback: without the guard, `fill-entry` would pick the cheapest 8 h
      // symbol and the settlement check would hold it for up to eight hours of real money.
      'fill-entry:skip',
      'position-tracking:skip',
      'funding-settlement:skip',
      'reduce-only-close:skip',
      'assert-flat:pass',
    ])
    expect(h.ctx.state.fill).toBeUndefined()
    expect(await h.sim.getPositions()).toEqual([])
  })

  it('fails naming the mapping gap when the venue credits funding but publishes no stream event', async () => {
    const h = harness()

    const summary = await runSuite(h, { dropAccrual: true })

    const settlement = summary.results.find((r) => r.name === 'funding-settlement')
    expect(settlement?.status).toBe('fail')
    expect(settlement?.reason).toMatch(/private stream published no FundingFeeAccrued/)
    // The gap is a reporting failure, not a money failure — the position is still closed flat.
    expect(h.ctx.state.teardown?.verifiedFlat).toBe(true)
    expect(await h.sim.getPositions()).toEqual([])
  })
})
