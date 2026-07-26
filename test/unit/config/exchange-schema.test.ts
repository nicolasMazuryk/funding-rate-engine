import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigParseError } from '../../../src/config/errors.js'
import { EXCHANGE_IDS, parseExchangeProfiles } from '../../../src/config/exchange-schema.js'

const exchangesYaml = readFileSync(fileURLToPath(new URL('../../../config/exchanges.yaml', import.meta.url)), 'utf8')

/**
 * The shipped OKX profile carries `deltas: {}` (task 0430: the venue runs the standard
 * defaults). Graft the spec's §4 worked-example deltas onto that one block so the delta
 * round-trip still runs against a realistic profile — the okx block is everything between
 * its own key and the next venue key.
 */
function withOkxDeltas(yaml: string): string {
  const start = yaml.indexOf('\nokx:\n')
  const end = yaml.indexOf('\nbitget:\n')
  if (start < 0 || end < 0) throw new Error('exchanges.yaml no longer has an okx block before bitget')
  const block = yaml
    .slice(start, end)
    .replace(
      '  deltas: {}',
      '  deltas:\n    funding_fee_timeout_seconds: 45\n    leverage: { s1: 4 }\n    ws_order_rest_fallback: true',
    )
  return yaml.slice(0, start) + block + yaml.slice(end)
}

describe('parseExchangeProfiles (09_configuration §4)', () => {
  it('parses the committed config/exchanges.yaml clean with all 6 venues', () => {
    const profiles = parseExchangeProfiles(exchangesYaml)
    for (const id of EXCHANGE_IDS) expect(profiles[id]).toBeDefined()
    expect(profiles.binance.takerFeePct).toBe(0.05)
    expect(profiles.binance.wsOrderAdapter).toBe(true)
    expect(profiles.bybit.submissionStaggerMs).toBe(150)
    expect(profiles.binance.ws.publicUrl.startsWith('wss://')).toBe(true)
  })

  it('round-trips the spec §4 worked-example deltas (nested leverage shape)', () => {
    // The `09` §4 example hangs its deltas off OKX, but they illustrate the delta
    // *mechanism*, not a confirmed venue fact — task 0430 ships OKX on the standard
    // defaults (`deltas: {}`), so the round-trip runs against a synthetic profile here
    // rather than asserting values nobody measured on the venue.
    const profiles = parseExchangeProfiles(withOkxDeltas(exchangesYaml))
    expect(profiles.okx.deltas.fundingFeeTimeoutSeconds).toBe(45)
    expect(profiles.okx.deltas.leverage).toEqual({ s1: 4 })
    expect(profiles.okx.deltas.wsOrderRestFallback).toBe(true)
  })

  it('parses the shipped OKX profile with no deltas and its demo-trading endpoints', () => {
    const profiles = parseExchangeProfiles(exchangesYaml)
    expect(profiles.okx.deltas).toEqual({})
    expect(profiles.okx.rateLimitWeightPerMinute).toBe(1200)
    expect(profiles.okx.rateLimitReservePct).toBe(50)
    expect(profiles.okx.testnet?.ws.publicUrl).toBe('wss://wspap.okx.com:8443/ws/v5/public')
  })

  it('rejects an unknown top-level venue key', () => {
    const bad = `${exchangesYaml}\nkraken:\n  taker_fee_pct: 0.05\n`
    expect(() => parseExchangeProfiles(bad)).toThrow(ConfigParseError)
  })

  it('rejects a missing venue', () => {
    const withoutKucoin = exchangesYaml.replace(/kucoin:[\s\S]*$/, '')
    try {
      parseExchangeProfiles(withoutKucoin)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
    }
  })

  it('rejects an unknown key inside a profile', () => {
    const bad = exchangesYaml.replace('  deltas: {}', '  bogus_key: 1\n  deltas: {}')
    expect(() => parseExchangeProfiles(bad)).toThrow(ConfigParseError)
  })

  it('accepts an empty deltas block and defaults it', () => {
    const profiles = parseExchangeProfiles(exchangesYaml)
    expect(profiles.binance.deltas.fundingFeeTimeoutSeconds).toBeUndefined()
    expect(profiles.binance.deltas.wsOrderRestFallback).toBeUndefined()
  })
})
