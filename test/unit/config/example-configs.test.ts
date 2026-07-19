import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StrategyId } from '../../../src/config/canonical.js'
import { parseStrategyConfig } from '../../../src/config/parse-strategy-config.js'

/** The 7 committed example configs, each keyed to its strategy id. */
const CONFIGS: ReadonlyArray<{ file: string; id: StrategyId }> = [
  { file: 's1-binance.yaml', id: 's1' },
  { file: 's1-ws-binance.yaml', id: 's1-ws' },
  { file: 's2-binance.yaml', id: 's2' },
  { file: 's3a-binance.yaml', id: 's3a' },
  { file: 's4-1a-binance.yaml', id: 's4-1a' },
  { file: 's4-2a-binance.yaml', id: 's4-2a' },
  { file: 's6-binance.yaml', id: 's6' },
]

const configDir = fileURLToPath(new URL('../../../config/', import.meta.url))

describe('example config/*.yaml files', () => {
  for (const { file, id } of CONFIGS) {
    it(`${file} parses clean with no warnings`, () => {
      const text = readFileSync(`${configDir}${file}`, 'utf8')
      const parsed = parseStrategyConfig(text, id)
      expect(parsed.instance.strategy).toBe(id)
      expect(parsed.instance.enabled).toBe(true)
      expect(parsed.warnings).toEqual([])
    })
  }

  it('resolves S6 sizing.amount_usd to mainAmountUsd', () => {
    const text = readFileSync(`${configDir}s6-binance.yaml`, 'utf8')
    const parsed = parseStrategyConfig(text, 's6')
    expect(parsed.sizing.mainAmountUsd).toBe(10)
    expect(parsed.sizing.amountUsd).toBeUndefined()
  })

  it('resolves non-S6 sizing.amount_usd to amountUsd', () => {
    const text = readFileSync(`${configDir}s1-binance.yaml`, 'utf8')
    const parsed = parseStrategyConfig(text, 's1')
    expect(parsed.sizing.amountUsd).toBe(10)
  })
})
