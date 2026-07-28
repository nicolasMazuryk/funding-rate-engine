/**
 * Unit: **`subAccountPreflight`** — the live tier's "are these the right keys?" gate
 * (task 0470 phase 3). The load-bearing behaviours are that violations **aggregate** (one run
 * tells the operator everything wrong) and that an unreadable account is a violation, not an
 * exception — with an auth-shaped failure naming the IP-allowlist hypothesis.
 *
 * No clock reads, no venue: a hand-rolled account stub, per `test/CLAUDE.md`.
 */

import { describe, expect, it } from 'vitest'
import type { Balance, Order, Position } from '../../../src/core/ports/exchange-adapter.js'
import { PREFLIGHT_BALANCE_MULTIPLE, subAccountPreflight } from '../../../src/live/preflight.js'

const ALLOCATED = 100

interface AccountScript {
  readonly balance?: Balance | Error
  readonly positions?: readonly Position[] | Error
  readonly orders?: readonly Order[] | Error
  readonly positionMode?: Error
}

function resolve<T>(value: T | Error | undefined, fallback: T): Promise<T> {
  if (value instanceof Error) return Promise.reject(value)
  return Promise.resolve(value ?? fallback)
}

function account(script: AccountScript = {}) {
  const modeCalls: string[] = []
  return {
    modeCalls,
    getBalance: () => resolve<Balance>(script.balance, { asset: 'USDT', free: 50, used: 0 }),
    getPositions: () => resolve<readonly Position[]>(script.positions, []).then((p) => [...p]),
    getOpenOrders: () => resolve<readonly Order[]>(script.orders, []).then((o) => [...o]),
    setPositionMode: (mode: string): Promise<void> => {
      modeCalls.push(mode)
      return script.positionMode ? Promise.reject(script.positionMode) : Promise.resolve()
    },
  }
}

function position(over: Partial<Position> = {}): Position {
  return { symbol: 'BTC', side: 'long', qty: 0.01, ...over }
}

function order(over: Partial<Order> = {}): Order {
  return { clientOrderId: 'c-1', symbol: 'BTC', side: 'long', type: 'limit', status: 'OPEN', ...over }
}

describe('subAccountPreflight (0470 phase 3)', () => {
  it('passes a small, flat, orderless sub-account and applies one-way mode', async () => {
    const exchange = account()

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.ok).toBe(true)
    expect(report.violations).toEqual([])
    expect(report.balanceUsdt).toBe(50)
    expect(report.maxBalanceUsdt).toBe(ALLOCATED * PREFLIGHT_BALANCE_MULTIPLE)
    expect(exchange.modeCalls).toEqual(['one_way'])
  })

  it('counts free + used against the ceiling, and passes at exactly 2x the allocation', async () => {
    // Boundary: `> ceiling` is the violation, so exactly 2× is still the right account.
    const exchange = account({ balance: { asset: 'USDT', free: 120, used: 80 } })

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.balanceUsdt).toBe(200)
    expect(report.ok).toBe(true)
  })

  it('refuses an account holding more than 2x its allocation — the wrong-keys case', async () => {
    const exchange = account({ balance: { asset: 'USDT', free: 9_000, used: 0 } })

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.ok).toBe(false)
    expect(report.violations.map((v) => v.kind)).toEqual(['balance_over_allocation'])
    expect(report.violations[0]?.detail).toContain('wrong keys')
  })

  it('aggregates every violation in one report rather than short-circuiting', async () => {
    const exchange = account({
      balance: { asset: 'USDT', free: 5_000, used: 0 },
      positions: [position()],
      orders: [order()],
      positionMode: new Error('hedge mode has open positions'),
    })

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.ok).toBe(false)
    expect(report.violations.map((v) => v.kind)).toEqual([
      'balance_over_allocation',
      'open_positions',
      'open_orders',
      'position_mode',
    ])
  })

  it('ignores closed (qty 0) positions', async () => {
    const exchange = account({ positions: [position({ qty: 0 })] })

    expect((await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })).ok).toBe(true)
  })

  it('turns a failed probe into a violation and still runs the remaining probes', async () => {
    const exchange = account({ balance: new Error('network down'), positions: [position()] })

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.ok).toBe(false)
    expect(report.balanceUsdt).toBeUndefined()
    expect(report.violations.map((v) => v.kind)).toEqual(['probe_failed', 'open_positions'])
    expect(exchange.modeCalls).toEqual(['one_way']) // the later probes ran anyway
  })

  it('names the IP-allowlist hypothesis on an auth-shaped failure', async () => {
    const authError = Object.assign(new Error('bybit 10003: API key is invalid'), { kind: 'AuthError' })
    const exchange = account({ balance: authError })

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.violations[0]?.detail).toContain('IP-allowlisted')
  })

  it('rewrites an auth-shaped message even without a typed kind', async () => {
    const exchange = account({ orders: new Error('okx 50113: invalid signature') })

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.violations.map((v) => v.kind)).toEqual(['probe_failed'])
    expect(report.violations[0]?.detail).toContain('IP-allowlisted')
  })

  it('leaves a non-auth failure unadorned', async () => {
    const exchange = account({ positions: new Error('ECONNRESET') })

    const report = await subAccountPreflight({ exchange, allocatedCapitalUsdt: ALLOCATED })

    expect(report.violations[0]?.detail).toBe('position read failed: ECONNRESET')
  })

  it('fails loud on a missing allocation rather than checking against an absent ceiling', async () => {
    await expect(subAccountPreflight({ exchange: account(), allocatedCapitalUsdt: 0 })).rejects.toThrow(
      /allocatedCapitalUsdt/,
    )
  })
})
