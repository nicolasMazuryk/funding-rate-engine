/**
 * Unit: Bitget client construction (`08` §6 ccxt/native split, `09` §4 testnet). Three things
 * are pinned here, all of them silent-failure risks rather than crashes:
 *
 *  1. **the passphrase.** Bitget is the second venue (after OKX) that signs with key + secret +
 *     passphrase. Absent, the clients would construct fine and only fail on the first signed
 *     call, so its absence must be a fail-loud startup error naming the env var.
 *  2. **`options.uta: true`, explicitly.** This is the load-bearing one. Left `undefined`, ccxt
 *     probes the account over the network (`handleUTAAndParams` → `GET /api/v3/account/settings`)
 *     on first use and *silently* routes a non-unified account to the v2 mix endpoints — a whole
 *     different API surface than the one the native WS order path speaks. Pinned `true`, a
 *     non-UTA account fails loud instead. `defaultType: 'swap'` is what makes `loadMarkets()`
 *     return the derivatives universe the `10` §3 filter narrows.
 *  3. **demo trading is a flag on the same account, not a network.** `network: 'testnet'` must
 *     reach ccxt as `setSandboxMode(true)` (the `PAPTRADING` header), not a host swap.
 *
 * Plus the rate-limiter derivation (`10` §6): the venue profile's budget, not a hard-coded
 * number, is what sizes both lanes.
 *
 * No network: `createBitgetClients` only constructs, and every assertion reads the constructed
 * objects' own config. Mirrors `../okx/factory.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createBitgetClients, createBitgetRateLimiter } from '../../../../../src/adapters/exchanges/bitget/factory.js'
import type { ParsedEnv } from '../../../../../src/config/env.js'
import type { ExchangeProfile } from '../../../../../src/config/exchange-schema.js'

/** A throwaway passphrase — never a real credential. */
const PASSPHRASE = 'test-passphrase-not-a-real-one'

const SECRETS: ParsedEnv['secrets'] = {
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  apiPassphrase: PASSPHRASE,
}

/** The shipped Bitget venue profile's shape; only the rate-limit fields are read downstream. */
const PROFILE = {
  takerFeePct: 0.06,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 33,
  rateLimitWeightPerMinute: 1800,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://ws.bitget.com/v3/ws/public', privateUrl: 'wss://ws.bitget.com/v3/ws/private' },
  deltas: {},
} as unknown as ExchangeProfile

/** ccxt's `options` bag, typed just enough to assert on it. */
function ccxtOptions(clients: ReturnType<typeof createBitgetClients>): Record<string, unknown> {
  return (clients.ccxt as unknown as { options: Record<string, unknown> }).options
}

describe('createBitgetClients — credentials', () => {
  it('threads the passphrase into ccxt as `password` (its name for the Bitget passphrase)', () => {
    const clients = createBitgetClients(PROFILE, SECRETS)
    expect((clients.ccxt as unknown as { password?: string }).password).toBe(PASSPHRASE)
    expect((clients.ccxt as unknown as { apiKey?: string }).apiKey).toBe(SECRETS.apiKey)
  })

  it('fails loud when the passphrase is absent — no client that would 40011 on first use', () => {
    expect(() => createBitgetClients(PROFILE, { apiKey: 'k', apiSecret: 's' })).toThrow(
      /BITGET_API_PASSPHRASE is required/,
    )
    // An empty string is the same failure as an absent one: `.env` sets the key with no value.
    expect(() => createBitgetClients(PROFILE, { apiKey: 'k', apiSecret: 's', apiPassphrase: '' })).toThrow(
      /BITGET_API_PASSPHRASE is required/,
    )
  })

  it('builds every client the adapter needs (ccxt + native REST + two WS + WS-API)', () => {
    const clients = createBitgetClients(PROFILE, SECRETS)
    for (const key of ['ccxt', 'native', 'wsPublic', 'wsPrivate', 'wsApiPrivate'] as const) {
      expect(clients[key]).toBeDefined()
    }
  })
})

describe('createBitgetClients — the UTA pin (v3, not v2 mix)', () => {
  it('sets `uta: true` explicitly rather than leaving ccxt to probe the account', () => {
    const clients = createBitgetClients(PROFILE, SECRETS)
    // Strictly `true`, not merely truthy: `undefined` is the failure mode under test — ccxt
    // would then network-probe and silently fall back to the v2 mix endpoints.
    expect(ccxtOptions(clients).uta).toBe(true)
  })

  it('defaults the market type to `swap` (the derivatives universe `10` §3 filters)', () => {
    const clients = createBitgetClients(PROFILE, SECRETS)
    expect(ccxtOptions(clients).defaultType).toBe('swap')
  })
})

describe('createBitgetClients — demo trading is a flag, not a network', () => {
  it('leaves sandbox mode off by default (`prod`)', () => {
    const clients = createBitgetClients(PROFILE, SECRETS)
    expect(ccxtOptions(clients).sandboxMode).toBeFalsy()
  })

  it("`network: 'testnet'` puts ccxt in sandbox mode (the PAPTRADING header on the same host)", () => {
    const clients = createBitgetClients(PROFILE, SECRETS, { network: 'testnet' })
    expect(ccxtOptions(clients).sandboxMode).toBe(true)
    // Same credentials, same construction path — demo is data, not a code branch.
    expect((clients.ccxt as unknown as { password?: string }).password).toBe(PASSPHRASE)
  })
})

describe('createBitgetRateLimiter (10 §6)', () => {
  it('derives both lanes from the profile budget, not a hard-coded number', async () => {
    const clock = createVirtualClock(0)
    const limiter = createBitgetRateLimiter(PROFILE, clock)
    // 1800/min at a 33 % reserve: 594 order tokens, 1206 general. The order lane spends its
    // own reserve first, then borrows idle general tokens — so the whole budget is available
    // to it while nothing else is reading.
    await limiter.acquire(594, 'order')
    await limiter.acquire(1206, 'order')
    // The order lane throws synchronously (it never waits — an order either fits now or is a
    // typed `RateLimited`), so the call is wrapped rather than awaited as a rejection.
    expect(() => limiter.acquire(1, 'order')).toThrow(/order lane exhausted/)
  })

  it('refills at the profile budget per minute', async () => {
    const clock = createVirtualClock(0)
    const limiter = createBitgetRateLimiter(PROFILE, clock)
    await limiter.acquire(1800, 'order')
    clock.advanceBy(60_000) // one minute = one full budget refilled
    await expect(limiter.acquire(1800, 'order')).resolves.toBeUndefined()
  })
})
