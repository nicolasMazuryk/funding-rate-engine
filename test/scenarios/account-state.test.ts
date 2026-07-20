/**
 * Scenario: **account-state layer** (task 0240) — the position/funding trackers and the
 * account-setup → preflight hard-reject path, driven through the sim venue with zero
 * credentials (`11` §1/§7/§8, `00_globals` §4/§5.3).
 *
 * Covers the four DoD moments:
 *  - reconcile-after-entry corrects a tracker↔venue divergence, REST winning;
 *  - an orphan (sim `setPosition`, `hasOwningIntent=false`) publishes `OrphanDetected`;
 *  - a `delayFundingFee`-delayed `FundingFeeAccrued` books to the right symbol;
 *  - a scripted `setLeverage` failure → symbol untradable → engine preflight rejects
 *    `account_setup_incomplete`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AccountSetupResult, runAccountSetup } from '../../src/execution/account-setup.js'
import { createFundingTracker } from '../../src/execution/funding-tracker.js'
import { createPositionTracker } from '../../src/execution/position-tracker.js'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { BTC, driveToEntry, INTENT_ID, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'
import { simHarness } from './sim-harness.js'

describe('scenario: position reconcile (REST wins) after entry', () => {
  it('corrects a tracker↔venue divergence, venue truth winning', async () => {
    const h = simHarness()
    const tracker = createPositionTracker({
      bus: h.bus,
      clock: h.clock,
      exchange: h.sim,
      hasOwningIntent: () => true,
      reconcileIntervalMs: 60_000,
    })

    // Entry fill publishes a PositionUpdate the tracker folds in.
    h.sim.setPrice('BTC', 60_000)
    await h.sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'entry' })
    expect(tracker.get('BTC')?.qty).toBe(0.001)

    // Venue truth drifts (a partial the WS missed); reconcile replaces tracked state.
    h.sim.setPosition('BTC', 'long', 0.002, 60_000)
    await tracker.reconcile()

    expect(tracker.get('BTC')).toEqual({ symbol: 'BTC', side: 'long', qty: 0.002, entryPrice: 60_000 })
    expect(h.events.filter((e) => e.type === 'OrphanDetected')).toEqual([]) // owned → not an orphan
    tracker.dispose()
  })
})

describe('scenario: orphan position (no owning intent)', () => {
  it('publishes OrphanDetected for a venue position no intent owns', async () => {
    const h = simHarness()
    const tracker = createPositionTracker({
      bus: h.bus,
      clock: h.clock,
      exchange: h.sim,
      hasOwningIntent: () => false, // nothing owns anything
      reconcileIntervalMs: 60_000,
    })

    h.sim.setPosition('BTC', 'short', 0.005, 60_000)
    await tracker.reconcile()

    expect(h.events.filter((e) => e.type === 'OrphanDetected')).toEqual([
      { type: 'OrphanDetected', symbol: 'BTC', qty: 0.005, side: 'short' },
    ])
    tracker.dispose()
  })
})

describe('scenario: late funding fee booking', () => {
  it('books a delayed FundingFeeAccrued to the right symbol after the delay elapses', async () => {
    const h = simHarness(0)
    const tracker = createFundingTracker({ bus: h.bus, exchange: h.sim })

    // Open a position so funding has something to accrue against.
    h.sim.setPrice('BTC', 60_000)
    await h.sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'entry' })

    h.sim.delayFundingFee(5_000)
    h.sim.settleFunding('BTC', -0.4, 1_000)

    // Fee delayed: not yet booked.
    expect(tracker.accrualsFor('BTC')).toEqual([])

    h.clock.advanceTo(6_000) // 1_000 + 5_000 delay
    const accruals = tracker.accrualsFor('BTC')
    expect(accruals.length).toBe(1)
    expect(accruals[0]?.fundingTime).toBe(1_000)
    expect(accruals[0]?.amount).toBeGreaterThan(0) // long under negative funding is credited
    tracker.dispose()
  })
})

describe('scenario: setLeverage failure → preflight account_setup_incomplete', () => {
  let tmp: TempDir

  beforeEach(() => {
    tmp = tempDir('account-state-')
  })
  afterEach(() => {
    tmp.dispose()
  })

  it('a scripted setLeverage failure makes the symbol untradable → engine rejects the entry', async () => {
    let setup: AccountSetupResult = { isReady: () => false }
    const h = buildSkeletonEngine({
      walPath: tmp.walPath,
      startMs: START_MS,
      accountSetupComplete: (symbol) => setup.isReady(symbol),
    })

    // Setup fails BTC's leverage → BTC untradable (hard reject, `00_globals` §4).
    h.exchange.scriptRateLimit('setLeverage', 'OrderRejected', [1])
    setup = await runAccountSetup(h.exchange, ['BTC'], () => 5)
    expect(setup.isReady('BTC')).toBe(false)

    driveToEntry(h)

    expect(h.engine.intentState(INTENT_ID)).toBe('ABORTED')
    const aborted = h.wal.readAll().find((r) => r.intentId === INTENT_ID && r.toState === 'ABORTED')
    const payload = aborted?.payload as { errorCode?: string }
    expect(payload.errorCode).toBe('account_setup_incomplete')
  })

  it('setup succeeds → the entry proceeds to MONITORING', async () => {
    let setup: AccountSetupResult = { isReady: () => false }
    const h = buildSkeletonEngine({
      walPath: tmp.walPath,
      startMs: START_MS,
      accountSetupComplete: (symbol) => setup.isReady(symbol),
    })

    setup = await runAccountSetup(h.exchange, [BTC.symbol], () => 5)
    expect(setup.isReady(BTC.symbol)).toBe(true)

    driveToEntry(h)

    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
  })
})
