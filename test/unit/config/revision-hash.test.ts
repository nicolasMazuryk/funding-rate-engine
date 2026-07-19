import { describe, expect, it } from 'vitest'
import { computeConfigRevisionHash, stableStringify } from '../../../src/config/revision-hash.js'

describe('computeConfigRevisionHash (09_configuration §7)', () => {
  const base = {
    exchange: 'binance',
    strategy: 's2',
    sizing: { amountUsd: 10, leverage: 5 },
    strategyParams: { deadlineSeconds: 900, fundingFeeTimeoutSeconds: 30 },
  }

  it('is stable across two runs of the same config (DoD #3 case 1)', () => {
    expect(computeConfigRevisionHash(base)).toBe(computeConfigRevisionHash(base))
  })

  it('is independent of key ordering', () => {
    const reordered = {
      strategyParams: { fundingFeeTimeoutSeconds: 30, deadlineSeconds: 900 },
      sizing: { leverage: 5, amountUsd: 10 },
      strategy: 's2',
      exchange: 'binance',
    }
    expect(computeConfigRevisionHash(reordered)).toBe(computeConfigRevisionHash(base))
  })

  it('changes when any parameter changes (DoD #3 case 2)', () => {
    const changed = { ...base, strategyParams: { ...base.strategyParams, deadlineSeconds: 901 } }
    expect(computeConfigRevisionHash(changed)).not.toBe(computeConfigRevisionHash(base))
  })

  it('excludes secrets by construction (caller passes a secret-free object)', () => {
    // The same secret-free input hashes identically regardless of any secrets the
    // caller holds — the hash never sees them.
    const hash = computeConfigRevisionHash(base)
    expect(hash).toBe(computeConfigRevisionHash({ ...base }))
    expect(stableStringify(base)).not.toMatch(/secret|apiKey|apiSecret/i)
  })
})
