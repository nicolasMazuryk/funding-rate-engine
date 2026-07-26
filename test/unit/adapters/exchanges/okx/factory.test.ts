/**
 * Unit: OKX client construction — task 0430's second definition-of-done, the **passphrase**.
 *
 * `src/config/env.ts` has parsed `${EXCHANGE}_API_PASSPHRASE` and `src/config/redaction.ts`
 * has listed the secret paths since task 0100, but until this venue **no factory had ever read
 * `secrets.apiPassphrase`** — Binance and Bybit sign with two credentials. So two things are
 * pinned here, and neither had a test before:
 *  1. the passphrase reaches the clients as OKX's `apiPass` / ccxt's `password`, and its
 *     absence is a **fail-loud startup error** rather than clients that would `50104` on the
 *     first signed call;
 *  2. it does not leak into a log line. `PINO_REDACTION_PATHS` had zero importers before this
 *     task; `src/replay/logger.ts` now builds pino with it, so a `secrets` object logged in
 *     full is censored.
 *
 * No network: `createOkxClients` only constructs, and the assertions read the constructed
 * ccxt object's own credential fields.
 */

import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { createOkxClients } from '../../../../../src/adapters/exchanges/okx/factory.js'
import type { ParsedEnv } from '../../../../../src/config/env.js'
import type { ExchangeProfile } from '../../../../../src/config/exchange-schema.js'
import { PINO_REDACTION_PATHS } from '../../../../../src/config/redaction.js'

/** A throwaway passphrase — never a real credential, and the string the leak test greps for. */
const PASSPHRASE = 'test-passphrase-not-a-real-one'

const SECRETS: ParsedEnv['secrets'] = {
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  apiPassphrase: PASSPHRASE,
}

/** The shipped OKX venue profile's shape; only the rate-limit fields are read downstream. */
const PROFILE = {
  takerFeePct: 0.05,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 50,
  rateLimitWeightPerMinute: 1200,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://ws.okx.com:8443/ws/v5/public', privateUrl: 'wss://ws.okx.com:8443/ws/v5/private' },
  deltas: {},
} as unknown as ExchangeProfile

describe('createOkxClients — the third credential', () => {
  it('threads the passphrase into ccxt as `password` (its name for the OKX passphrase)', () => {
    const clients = createOkxClients(PROFILE, SECRETS)
    expect((clients.ccxt as unknown as { password?: string }).password).toBe(PASSPHRASE)
    expect((clients.ccxt as unknown as { apiKey?: string }).apiKey).toBe(SECRETS.apiKey)
  })

  it('builds every client the adapter needs (ccxt + native REST + two WS + WS-API)', () => {
    const clients = createOkxClients(PROFILE, SECRETS)
    for (const key of ['ccxt', 'native', 'wsPublic', 'wsPrivate', 'wsApiPrivate'] as const) {
      expect(clients[key]).toBeDefined()
    }
  })

  it('fails loud when the passphrase is absent — no client that would 50104 on first use', () => {
    expect(() => createOkxClients(PROFILE, { apiKey: 'k', apiSecret: 's' })).toThrow(/OKX_API_PASSPHRASE is required/)
    expect(() => createOkxClients(PROFILE, { apiKey: 'k', apiSecret: 's', apiPassphrase: '' })).toThrow(
      /OKX_API_PASSPHRASE is required/,
    )
  })

  it('demo trading is a flag on the same account, not a separate network', () => {
    // Both construct from the identical credentials; only `network` differs (`09` §4 testnet).
    expect(() => createOkxClients(PROFILE, SECRETS, { network: 'testnet' })).not.toThrow()
  })
})

describe('secret redaction (09 §2) — the passphrase never reaches a log line', () => {
  /** Capture pino's own output, configured exactly as `createLogger` configures it. */
  function capture(payload: Record<string, unknown>): string {
    const lines: string[] = []
    const logger = pino({ level: 'info', redact: { paths: [...PINO_REDACTION_PATHS], censor: '[redacted]' } }, {
      write: (line: string) => lines.push(line),
    } as unknown as pino.DestinationStream)
    logger.info(payload, 'startup')
    return lines.join('')
  }

  it('censors the whole secrets triple, passphrase included', () => {
    const line = capture({ secrets: SECRETS })
    expect(line).not.toContain(PASSPHRASE)
    expect(line).not.toContain(SECRETS.apiSecret)
    expect(line).not.toContain(SECRETS.apiKey)
    expect(line).toContain('[redacted]')
  })

  it('leaves non-secret fields intact (redaction is targeted, not a blanket scrub)', () => {
    const line = capture({ secrets: SECRETS, exchange: 'okx' })
    expect(line).toContain('"exchange":"okx"')
  })
})
