import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigParseError } from '../../../src/config/errors.js'
import { loadEffectiveConfigFromSources } from '../../../src/config/load.js'
import { strategyYaml } from './fixtures.js'

const exchangesYamlText = readFileSync(
  fileURLToPath(new URL('../../../config/exchanges.yaml', import.meta.url)),
  'utf8',
)

const BASE_ENV: Record<string, string | undefined> = {
  EXCHANGE: 'binance',
  STRATEGY: 's2',
  SUBACCOUNT: 'fund-s2-binance',
  DATABASE_URL: 'postgres://user:pass@host:5432/trading_fleet',
  BINANCE_API_KEY: 'key-123',
  BINANCE_API_SECRET: 'secret-456',
}

function sources(over: Partial<{ envRecord: Record<string, string | undefined>; strategyYamlText: string }> = {}) {
  return {
    envRecord: over.envRecord ?? { ...BASE_ENV },
    strategyYamlText: over.strategyYamlText ?? strategyYaml({ strategy: 's2' }),
    exchangesYamlText,
  }
}

describe('loadEffectiveConfigFromSources (09_configuration §5)', () => {
  it('produces a frozen EffectiveConfig with a revision hash on the happy path', () => {
    const cfg = loadEffectiveConfigFromSources(sources())
    expect(cfg.exchange).toBe('binance')
    expect(cfg.strategy).toBe('s2')
    expect(cfg.strategyParams.fundingFeeTimeoutSeconds).toBe(30)
    expect(cfg.exchangeProfile.takerFeePct).toBe(0.05)
    expect(cfg.secrets.apiKey).toBe('key-123')
    expect(cfg.revisionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(cfg)).toBe(true)
  })

  it('is deterministic — same sources hash identically', () => {
    expect(loadEffectiveConfigFromSources(sources()).revisionHash).toBe(
      loadEffectiveConfigFromSources(sources()).revisionHash,
    )
  })

  it('rejects a mutation attempt on the frozen config (DoD #4)', () => {
    const cfg = loadEffectiveConfigFromSources(sources())
    expect(() => {
      ;(cfg as { revisionHash: string }).revisionHash = 'tampered'
    }).toThrow(TypeError)
    expect(() => {
      ;(cfg.strategyParams as Record<string, number>).deadlineSeconds = 1
    }).toThrow(TypeError)
  })

  it('throws ConfigParseError naming the key on a missing secret (DoD #2 case 5)', () => {
    const { BINANCE_API_SECRET, ...noSecret } = BASE_ENV
    void BINANCE_API_SECRET
    try {
      loadEffectiveConfigFromSources(sources({ envRecord: noSecret }))
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('missing_secret')
      expect((e as ConfigParseError).message).toMatch(/BINANCE_API_SECRET/)
    }
  })

  it('throws exchange_mismatch when the strategy YAML exchange differs from .env', () => {
    const mismatched = strategyYaml({ strategy: 's2' }).replace('exchange: binance', 'exchange: bybit')
    try {
      loadEffectiveConfigFromSources(sources({ strategyYamlText: mismatched }))
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('exchange_mismatch')
    }
  })

  it('carries a sizing feasibility warning when amount_usd is below the floor', () => {
    const tiny = strategyYaml({ strategy: 's2', sizing: { amount_usd: 3, leverage: 5 } })
    const cfg = loadEffectiveConfigFromSources(sources({ strategyYamlText: tiny }))
    expect(cfg.warnings.some((w) => /feasibility hint/.test(w))).toBe(true)
  })

  it('rejects a Group-L threshold too shallow to clear fees (00_globals §11-R10)', () => {
    const uneconomic = strategyYaml({
      strategy: 's1',
      params: { negative_funding_threshold_percent: -0.1, entry_offset_seconds: 3, exit_offset_seconds: 6 },
    })
    try {
      loadEffectiveConfigFromSources(
        sources({ envRecord: { ...BASE_ENV, STRATEGY: 's1' }, strategyYamlText: uneconomic }),
      )
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('uneconomic_structural_config')
    }
  })

  it('loads a Group-L strategy at the default threshold (−0.4 clears fees)', () => {
    const cfg = loadEffectiveConfigFromSources(
      sources({ envRecord: { ...BASE_ENV, STRATEGY: 's1' }, strategyYamlText: strategyYaml({ strategy: 's1' }) }),
    )
    expect(cfg.strategy).toBe('s1')
    expect(cfg.strategyParams.negativeFundingThresholdPercent).toBe(-0.4)
  })
})
