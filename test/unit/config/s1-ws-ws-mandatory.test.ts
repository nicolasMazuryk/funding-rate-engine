/**
 * S1-WS WS-mandatory startup guard (task 0300 DoD #3; `00_globals.md` §6, `09` §6).
 * S1-WS is the first WS-mandatory strategy, so `load()` must refuse to boot it on a venue
 * profile without a WS order adapter *and* without REST fallback, and must boot it when
 * either capability is present. Exercised through the full `loadEffectiveConfigFromSources`
 * pipeline (not just the pure `checkWsMandatoryGuard`) so the guard is proven wired.
 */

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

const S1_WS_ENV: Record<string, string | undefined> = {
  EXCHANGE: 'binance',
  STRATEGY: 's1-ws',
  SUBACCOUNT: 'fund-s1-ws-binance',
  DATABASE_URL: 'postgres://user:pass@host:5432/trading_fleet',
  BINANCE_API_KEY: 'key-123',
  BINANCE_API_SECRET: 'secret-456',
}

/** The real binance profile advertises a WS order adapter; flip only that field to false. */
const NO_WS_ADAPTER = exchangesYamlText.replace('ws_order_adapter: true', 'ws_order_adapter: false')

function sources(exchangesText: string) {
  return {
    envRecord: { ...S1_WS_ENV },
    strategyYamlText: strategyYaml({ strategy: 's1-ws' }),
    exchangesYamlText: exchangesText,
  }
}

describe('S1-WS WS-mandatory startup guard (09 §6, DoD #3)', () => {
  it('loads on the real binance profile (WS order adapter present)', () => {
    const cfg = loadEffectiveConfigFromSources(sources(exchangesYamlText))
    expect(cfg.strategy).toBe('s1-ws')
    expect(cfg.strategyParams.fundingFeeTimeoutSeconds).toBe(10)
    expect(cfg.exchangeProfile.wsOrderAdapter).toBe(true)
  })

  it('throws ws_order_adapter_required when the profile has no WS adapter and no fallback', () => {
    try {
      loadEffectiveConfigFromSources(sources(NO_WS_ADAPTER))
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).code).toBe('ws_order_adapter_required')
    }
  })
})
