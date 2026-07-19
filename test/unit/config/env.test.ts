import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../../src/config/env.js'
import { ConfigParseError } from '../../../src/config/errors.js'

const BASE: Record<string, string | undefined> = {
  EXCHANGE: 'binance',
  STRATEGY: 's1-ws',
  SUBACCOUNT: 'fund-s1ws-binance',
  DATABASE_URL: 'postgres://user:pass@host:5432/trading_fleet',
  BINANCE_API_KEY: 'key-123',
  BINANCE_API_SECRET: 'secret-456',
}

describe('parseEnv (09_configuration §2)', () => {
  it('parses a valid env with defaults', () => {
    const e = parseEnv({ ...BASE })
    expect(e.exchange).toBe('binance')
    expect(e.strategy).toBe('s1-ws')
    expect(e.logLevel).toBe('info') // default
    expect(e.killSwitch).toBe('off') // default
    expect(e.secrets.apiKey).toBe('key-123')
    expect(e.secrets.apiPassphrase).toBeUndefined()
  })

  it('applies explicit LOG_LEVEL and KILL_SWITCH', () => {
    const e = parseEnv({ ...BASE, LOG_LEVEL: 'debug', KILL_SWITCH: 'flatten' })
    expect(e.logLevel).toBe('debug')
    expect(e.killSwitch).toBe('flatten')
  })

  it('carries an optional passphrase when present', () => {
    const e = parseEnv({ ...BASE, BINANCE_API_PASSPHRASE: 'pass-789' })
    expect(e.secrets.apiPassphrase).toBe('pass-789')
  })

  it('rejects an unknown EXCHANGE', () => {
    expect(() => parseEnv({ ...BASE, EXCHANGE: 'kraken' })).toThrow(ConfigParseError)
  })

  it('rejects an unknown STRATEGY', () => {
    expect(() => parseEnv({ ...BASE, STRATEGY: 'strategy_9' })).toThrow(ConfigParseError)
  })

  it('rejects missing secrets for the selected exchange', () => {
    const { BINANCE_API_SECRET, ...noSecret } = BASE
    void BINANCE_API_SECRET
    try {
      parseEnv(noSecret)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('missing_secret')
    }
  })

  it('rejects an empty required secret', () => {
    expect(() => parseEnv({ ...BASE, BINANCE_API_KEY: '' })).toThrow(ConfigParseError)
  })
})
