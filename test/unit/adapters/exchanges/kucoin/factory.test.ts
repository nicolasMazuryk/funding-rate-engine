/**
 * Unit: KuCoin client construction (`08` §6 ccxt/native split, `09` §4 testnet). Two silent
 * failures are pinned here — neither would crash, both would trade wrong:
 *
 *  1. **the ccxt class must be `kucoinfutures`, not `kucoin`.** KuCoin is the first split-class
 *     venue in this repo: `ccxt.kucoin` is the *spot* exchange. Built with it, `loadMarkets()`
 *     returns spot pairs, the `10` §3 filter (`type === 'swap'`, `settle === 'USDT'`) drops every
 *     one of them, and startup produces an **empty universe rather than an error** — the engine
 *     would boot, subscribe to nothing and trade nothing, forever.
 *  2. **the factory must expose no network/sandbox option at all.** KuCoin decommissioned its
 *     futures sandbox. `ccxt.kucoinfutures` carries no `urls.test`, and `setSandboxMode(true)`
 *     does **not** throw — it silently empties `urls.api`, so every later call fails with an
 *     unrelated URL error far from the cause. An option that can only ever misfire is worse than
 *     no option, so there is none; the verification tier is read-only against live instead
 *     (`src/testnet/kucoin/`). Both halves of that trap are asserted below so a future "add
 *     testnet support for consistency" edit fails here.
 *
 * Plus the passphrase (KuCoin's third credential, after OKX and Bitget) and the rate-limiter
 * derivation (`10` §6) — KuCoin is the first venue with a *real* published weight model, so the
 * profile budget, not a hard-coded number, is what sizes both lanes.
 *
 * No network: `createKucoinClients` only constructs, and every assertion reads the constructed
 * objects' own config or the exported function's own shape.
 */

import ccxt from 'ccxt'
import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import { createKucoinClients, createKucoinRateLimiter } from '../../../../../src/adapters/exchanges/kucoin/factory.js'
import type { ParsedEnv } from '../../../../../src/config/env.js'
import type { ExchangeProfile } from '../../../../../src/config/exchange-schema.js'

/** A throwaway passphrase — never a real credential. */
const PASSPHRASE = 'test-passphrase-not-a-real-one'

const SECRETS: ParsedEnv['secrets'] = {
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  apiPassphrase: PASSPHRASE,
}

/** The shipped KuCoin venue profile's shape; only the rate-limit fields are read downstream. */
const PROFILE = {
  takerFeePct: 0.06,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 33,
  rateLimitWeightPerMinute: 3600,
  wsOrderAdapter: true,
  ws: {
    publicUrl: 'https://api-futures.kucoin.com/api/v1/bullet-public',
    privateUrl: 'https://api-futures.kucoin.com/api/v1/bullet-private',
  },
  deltas: {},
} as unknown as ExchangeProfile

describe('createKucoinClients — the futures class, not the spot one', () => {
  it('builds ccxt.kucoinfutures', () => {
    const clients = createKucoinClients(PROFILE, SECRETS)
    expect(clients.ccxt).toBeInstanceOf(ccxt.kucoinfutures)
    expect((clients.ccxt as unknown as { id: string }).id).toBe('kucoinfutures')
  })

  it('does not build ccxt.kucoin (spot) — the empty-universe failure', () => {
    const clients = createKucoinClients(PROFILE, SECRETS)
    // `instanceof ccxt.kucoin` cannot express this: in ccxt `kucoinfutures extends kucoin`, so it
    // is true for both. The exchange **id** is the discriminator, and it is what every ccxt call
    // path keys off.
    expect((clients.ccxt as unknown as { id: string }).id).not.toBe('kucoin')
    expect(Object.getPrototypeOf(ccxt.kucoinfutures).name).toBe('kucoin') // documents why, above
  })

  it('defaults the market type to `swap` (the derivatives universe `10` §3 filters)', () => {
    const clients = createKucoinClients(PROFILE, SECRETS)
    expect((clients.ccxt as unknown as { options: Record<string, unknown> }).options.defaultType).toBe('swap')
  })

  it('builds every client the adapter needs (ccxt + native REST + two WS + WS-API)', () => {
    const clients = createKucoinClients(PROFILE, SECRETS)
    for (const key of ['ccxt', 'native', 'wsPublic', 'wsPrivate', 'wsApiPrivate'] as const) {
      expect(clients[key]).toBeDefined()
    }
  })
})

describe('createKucoinClients — credentials', () => {
  it('threads the passphrase into ccxt as `password` (its name for the KuCoin passphrase)', () => {
    const clients = createKucoinClients(PROFILE, SECRETS)
    expect((clients.ccxt as unknown as { password?: string }).password).toBe(PASSPHRASE)
    expect((clients.ccxt as unknown as { apiKey?: string }).apiKey).toBe(SECRETS.apiKey)
  })

  it('fails loud when the passphrase is absent — no client that would 400003 on first use', () => {
    expect(() => createKucoinClients(PROFILE, { apiKey: 'k', apiSecret: 's' })).toThrow(
      /KUCOIN_API_PASSPHRASE is required/,
    )
    // An empty string is the same failure as an absent one: `.env` sets the key with no value.
    expect(() => createKucoinClients(PROFILE, { apiKey: 'k', apiSecret: 's', apiPassphrase: '' })).toThrow(
      /KUCOIN_API_PASSPHRASE is required/,
    )
  })
})

describe('createKucoinClients — there is no network/sandbox option, deliberately', () => {
  it('takes exactly two parameters: profile and secrets (no options bag)', () => {
    // The OKX and Bitget factories take a third `{ network }` argument. This one must not: an
    // arity of 3 here means someone added the option back.
    expect(createKucoinClients.length).toBe(2)
  })

  it('never calls setSandboxMode and never branches on a network', () => {
    const source = createKucoinClients.toString()
    expect(source).not.toContain('setSandboxMode')
    expect(source).not.toContain('sandbox')
    expect(source).not.toContain('testnet')
  })

  it('leaves ccxt in its live configuration — a populated urls.api', () => {
    const clients = createKucoinClients(PROFILE, SECRETS)
    const urls = (clients.ccxt as unknown as { urls: { api: Record<string, unknown>; test?: unknown } }).urls
    expect(Object.keys(urls.api).length).toBeGreaterThan(0)
  })

  it('documents the trap: kucoinfutures has no urls.test, and setSandboxMode silently breaks it', () => {
    // A throwaway instance, never the adapter's — this is the venue fact the absent option
    // encodes. If ccxt ever ships a real futures sandbox, both lines change and the decision in
    // `factory.ts` can be revisited on evidence.
    const probe = new ccxt.kucoinfutures({})
    expect(probe.urls.test).toBeUndefined()
    expect(() => probe.setSandboxMode(true)).not.toThrow() // no error — that is the whole problem
    expect(Object.keys(probe.urls.api as Record<string, unknown>)).toEqual([])
  })
})

describe('createKucoinRateLimiter (10 §6)', () => {
  it('derives both lanes from the profile budget, not a hard-coded number', async () => {
    const clock = createVirtualClock(0)
    const limiter = createKucoinRateLimiter(PROFILE, clock)
    // 3600 weight/min at a 33 % reserve: 1188 order tokens, 2412 general. The order lane spends
    // its own reserve first, then borrows idle general tokens — so the whole budget is available
    // to it while nothing else is reading.
    await limiter.acquire(1188, 'order')
    await limiter.acquire(2412, 'order')
    // The order lane throws synchronously (it never waits — an order either fits now or is a
    // typed `RateLimited`), so the call is wrapped rather than awaited as a rejection.
    expect(() => limiter.acquire(1, 'order')).toThrow(/order lane exhausted/)
  })

  it('refills at the profile budget per minute', async () => {
    const clock = createVirtualClock(0)
    const limiter = createKucoinRateLimiter(PROFILE, clock)
    await limiter.acquire(3600, 'order')
    clock.advanceBy(60_000) // one minute = one full budget refilled
    await expect(limiter.acquire(3600, 'order')).resolves.toBeUndefined()
  })
})
