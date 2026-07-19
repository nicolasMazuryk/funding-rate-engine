import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigParseError } from '../../../src/config/errors.js'
import { EXCHANGE_IDS, parseExchangeProfiles } from '../../../src/config/exchange-schema.js'

const exchangesYaml = readFileSync(fileURLToPath(new URL('../../../config/exchanges.yaml', import.meta.url)), 'utf8')

describe('parseExchangeProfiles (09_configuration §4)', () => {
  it('parses the committed config/exchanges.yaml clean with all 6 venues', () => {
    const profiles = parseExchangeProfiles(exchangesYaml)
    for (const id of EXCHANGE_IDS) expect(profiles[id]).toBeDefined()
    expect(profiles.binance.takerFeePct).toBe(0.05)
    expect(profiles.binance.wsOrderAdapter).toBe(true)
    expect(profiles.bybit.submissionStaggerMs).toBe(150)
    expect(profiles.binance.ws.publicUrl.startsWith('wss://')).toBe(true)
  })

  it('round-trips the OKX worked-example deltas (nested leverage shape)', () => {
    const profiles = parseExchangeProfiles(exchangesYaml)
    expect(profiles.okx.deltas.fundingFeeTimeoutSeconds).toBe(45)
    expect(profiles.okx.deltas.leverage).toEqual({ s1: 4 })
    expect(profiles.okx.deltas.wsOrderRestFallback).toBe(true)
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
