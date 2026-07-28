/**
 * Unit: the `fill-test` suite (task 0470 phase 6) driven end to end against the sim venue.
 *
 * The live tier's own checks are the only code between the caps and a real fill, so they are
 * tested the way the CLI runs them: the whole registry list through `runChecks`, against the
 * capped adapter the live context builds, on a virtual clock. What that pins down:
 *
 *  - the entry is a **priced, marketable** order — it fills, and the cap still measured it;
 *  - the fill's `fillPx`/`fee` become the run's money truth (`state.feesUsd`, the verdict's
 *    input for the suite fee bound);
 *  - the position reaches the engine's own tracker **off the stream**, not only off REST;
 *  - the close is reduce-only and the cap's exemption lets it through untouched;
 *  - the suite ends verified flat.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../../src/adapters/sim/sim-exchange.js'
import type { ExchangeProfile } from '../../../src/config/exchange-schema.js'
import type { SubaccountRow } from '../../../src/config/subaccounts.js'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { EngineEvent } from '../../../src/core/events/types.js'
import { resolveCaps } from '../../../src/live/caps.js'
import type { LiveContext } from '../../../src/live/context.js'
import { withNotionalCap } from '../../../src/live/notional-cap.js'
import { LIVE_SUITE_CHECKS } from '../../../src/live/registry.js'
import { createTeardown } from '../../../src/live/teardown.js'
import { runChecks } from '../../../src/testnet/runner.js'
import type { TestnetSummary } from '../../../src/testnet/types.js'

const START_MS = 1_700_000_000_000
/** 100k puts BTC's `minQty` (0.001) at 100 USD — over the cap, so the picker must skip it. */
const BTC_PRICE = 100_000
/** 2k puts ETH's `minQty` (0.01) at 20 USD — the cheapest candidate that fits the 25 USD cap. */
const ETH_PRICE = 2_000
/** Where `fill-test` submits: 0.5 % through last, tick-rounded (`0.01`) — 20.10 USD of notional. */
const ETH_MARKETABLE_PRICE = 2_010
/** The sim's taker model: 0.04 % of notional, charged on both legs of the round trip. */
const SIM_TAKER_PCT = 0.0004

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

function harness(): Harness {
  const clock = createVirtualClock(START_MS)
  const bus = createEventBus()
  const sim = createSimExchange(clock, bus)
  const prices = new Map<string, number>([
    ['BTC', BTC_PRICE],
    ['ETH', ETH_PRICE],
    ['PEPE', 0.01],
  ])
  for (const [symbol, px] of prices) sim.setPrice(symbol, px)

  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))
  const adapter = withNotionalCap(sim, { caps: resolveCaps(), bus, clock })

  const ctx: Omit<LiveContext, 'onCleanup'> = {
    hasCredentials: true,
    venue: 'binance',
    suite: 'fill-test',
    adapter,
    clock,
    bus,
    events,
    // No live check reads the venue profile — it exists on the context for the builders.
    profile: {} as ExchangeProfile,
    subaccount: SUBACCOUNT,
    caps: resolveCaps(),
    teardown: createTeardown({ exchange: adapter, cancelSweep: () => Promise.resolve([]), clock, bus }),
    state: { feesUsd: 0 },
    tracePath: 'test/live/unit.trace.jsonl',
    log: () => {},
    lastPrice: (symbol: string) => Promise.resolve(prices.get(symbol) as number),
    close: () => Promise.resolve(),
  }
  return { clock, sim, ctx, events }
}

/**
 * Drive a live suite to completion on the virtual clock. Re-setting the sim price on every turn
 * is what crosses the resting marketable order — the sim only matches on a price update — and
 * advancing the clock is what releases the checks' `retryOnClock` polls and teardown's settle.
 */
async function settle<T>(promise: Promise<T>, h: Harness): Promise<T> {
  let done = false
  void promise.then(() => {
    done = true
  })
  for (let i = 0; i < 200 && !done; i++) {
    await Promise.resolve()
    h.sim.setPrice('ETH', ETH_PRICE)
    h.clock.advanceBy(1_000)
  }
  return promise
}

function runSuite(h: Harness): Promise<TestnetSummary> {
  return settle(
    runChecks('binance', '1', LIVE_SUITE_CHECKS['fill-test'], h.ctx, {
      now: () => h.clock.now(),
      network: 'prod',
    }),
    h,
  )
}

describe('live fill-test suite (0470 phase 6)', () => {
  it('fills a marketable entry, tracks the position, and closes it reduce-only', async () => {
    const h = harness()

    const summary = await runSuite(h)

    expect(summary.results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'subaccount-preflight:pass',
      'fill-entry:pass',
      'position-tracking:pass',
      'reduce-only-close:pass',
      'assert-flat:pass',
    ])
    expect(h.ctx.state.teardown?.verifiedFlat).toBe(true)
    expect(await h.sim.getPositions()).toEqual([])
  })

  it('picks the cheapest symbol that fits the cap and fills it as a priced order', async () => {
    const h = harness()

    await runSuite(h)

    // BTC's smallest order is 100 USD — 4× the per-order cap — so the picker must reject it.
    expect(h.ctx.state.symbol?.symbol).toBe('ETH')
    const fill = h.ctx.state.fill
    expect(fill?.symbol).toBe('ETH')
    expect(fill?.qty).toBe(0.01)
    // Marketable: submitted 0.5 % through last, and a limit fills at its own price.
    expect(fill?.fillPx).toBe(ETH_MARKETABLE_PRICE)
    // Priced, so the cap measured it — 20.10 USD, under the 25 USD ceiling — rather than
    // refusing it as unpriceable the way a market order would have been refused.
    expect(h.ctx.state.symbol?.notionalUsd).toBeCloseTo(ETH_MARKETABLE_PRICE * 0.01, 6)
    expect(h.ctx.state.symbol?.notionalUsd).toBeLessThanOrEqual(resolveCaps().maxOrderNotionalUsd)
    expect(h.ctx.adapter.cap.rejections).toEqual([])
  })

  it('accumulates the round-trip fee both legs really cost', async () => {
    const h = harness()

    await runSuite(h)

    const entryFee = ETH_MARKETABLE_PRICE * 0.01 * SIM_TAKER_PCT
    const closeFee = ETH_PRICE * 0.01 * SIM_TAKER_PCT
    expect(h.ctx.state.fill?.feeUsd).toBeCloseTo(entryFee, 8)
    expect(h.ctx.state.feesUsd).toBeCloseTo(entryFee + closeFee, 8)
  })

  it('sees the position on the private stream, not only on the REST reconcile', async () => {
    const h = harness()

    const summary = await runSuite(h)

    const tracking = summary.results.find((r) => r.name === 'position-tracking')
    expect(tracking?.detail).toMatchObject({ symbol: 'ETH', source: 'stream', trackedQty: 0.01, filledQty: 0.01 })
  })

  it('closes reduce-only, so the cap exemption — not the ceiling — governs the exit', async () => {
    const h = harness()

    const summary = await runSuite(h)

    const close = summary.results.find((r) => r.name === 'reduce-only-close')
    expect(close?.detail).toMatchObject({ symbol: 'ETH', closeSide: 'short', qty: 0.01 })
    // The exit releases the entry's reservation: a reduce-only order is exempt by construction.
    expect(h.ctx.adapter.cap.exposureUsd()).toBe(0)
    expect(h.ctx.adapter.cap.rejections).toEqual([])
  })

  it('skips the fill checks without an ok preflight rather than trading a wrong account', async () => {
    const h = harness()
    // A balance far over the sub-account's allocation is preflight's "wrong account" signal.
    const tiny: Omit<LiveContext, 'onCleanup'> = {
      ...h.ctx,
      subaccount: { ...SUBACCOUNT, allocatedCapitalUsdt: 1 },
      state: { feesUsd: 0 },
    }

    const summary = await settle(
      runChecks('binance', '1', LIVE_SUITE_CHECKS['fill-test'], tiny, {
        now: () => h.clock.now(),
        network: 'prod',
      }),
      h,
    )

    expect(summary.results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'subaccount-preflight:fail',
      'fill-entry:skip',
      'position-tracking:skip',
      'reduce-only-close:skip',
      'assert-flat:pass',
    ])
    expect(tiny.state.fill).toBeUndefined()
    expect(await h.sim.getPositions()).toEqual([]) // nothing was traded on the wrong account
  })
})
