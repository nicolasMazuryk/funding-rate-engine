import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigParseError } from '../../../src/config/errors.js'
import {
  parseSubaccountSecrets,
  parseSubaccounts,
  type SubaccountSources,
  selectSubaccount,
} from '../../../src/config/subaccounts.js'

/**
 * Live sub-account registry loader (task 0470). The committed `config/subaccounts.yaml` is
 * exercised as-is; the secrets side uses synthetic text — the real credentials file is
 * gitignored and must never be a test dependency.
 */

const subaccountsYamlText = readFileSync(
  fileURLToPath(new URL('../../../config/subaccounts.yaml', import.meta.url)),
  'utf8',
)

const secretsYamlText = `
secrets:
  - exchange: binance
    strategy: s1-ws
    api_key: bin-key
    api_secret: bin-secret
  - exchange: kucoin
    strategy: strategy_2
    api_key: kc-key
    api_secret: kc-secret
    api_passphrase: kc-pass
`

const sources: SubaccountSources = { subaccountsYamlText, secretsYamlText }

/** Assert `fn` throws a `ConfigParseError` carrying `code`. */
function expectConfigError(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(ConfigParseError)
  try {
    fn()
  } catch (e) {
    expect((e as ConfigParseError).code).toBe(code)
  }
}

describe('parseSubaccounts (committed registry)', () => {
  it('parses every migrated row, secret-free', () => {
    const rows = parseSubaccounts(subaccountsYamlText)
    expect(rows).toHaveLength(25)
    // The five venues, five strategies each — gate.io was dropped in the migration.
    expect(new Set(rows.map((r) => r.exchange))).toEqual(new Set(['binance', 'bybit', 'okx', 'bitget', 'kucoin']))
    expect(new Set(rows.map((r) => r.strategy))).toEqual(new Set(['s1-ws', 's2', 's3a', 's4-1a', 's6']))
    expect(rows.every((r) => r.status === 'active')).toBe(true)
    // No credential-shaped key survived the migration.
    expect(JSON.stringify(rows)).not.toMatch(/api_?(key|secret|passphrase)/i)
  })

  it('normalizes spec-09 long-form strategy names to short ids', () => {
    const rows = parseSubaccounts(`
subaccounts:
  - exchange: okx
    strategy: strategy_4_1a
    sub_account_id: "sub-1"
    sub_account_label: "sub-1"
    allocated_capital_usdt: 100
    status: active
`)
    expect(rows[0]?.strategy).toBe('s4-1a')
  })

  it('rejects an unknown strategy, an unknown key, and a duplicate pair', () => {
    const row = (extra: string, strategy = 's2') => `
subaccounts:
  - exchange: okx
    strategy: ${strategy}
    sub_account_id: "sub-1"
    sub_account_label: "sub-1"
    allocated_capital_usdt: 100
    status: active${extra}
`
    expectConfigError(() => parseSubaccounts(row('', 'strategy_9')), 'invalid_value')
    expectConfigError(() => parseSubaccounts(row('\n    ip_allow_list: [1.2.3.4]')), 'unrecognized_keys')
    expectConfigError(
      () =>
        parseSubaccounts(`${row('')}  - exchange: okx
    strategy: s2
    sub_account_id: "sub-2"
    sub_account_label: "sub-2"
    allocated_capital_usdt: 100
    status: active
`),
      'duplicate_subaccount',
    )
  })
})

describe('parseSubaccountSecrets', () => {
  it('normalizes aliases and keeps the passphrase only where the venue needs one', () => {
    const rows = parseSubaccountSecrets(secretsYamlText)
    expect(rows).toEqual([
      { exchange: 'binance', strategy: 's1-ws', apiKey: 'bin-key', apiSecret: 'bin-secret' },
      { exchange: 'kucoin', strategy: 's2', apiKey: 'kc-key', apiSecret: 'kc-secret', apiPassphrase: 'kc-pass' },
    ])
  })

  it('rejects a passphrase-venue row without one, and a non-passphrase venue with one', () => {
    const secret = (exchange: string, pass: string) => `
secrets:
  - exchange: ${exchange}
    strategy: s2
    api_key: k
    api_secret: s${pass}
`
    expectConfigError(() => parseSubaccountSecrets(secret('bitget', '')), 'missing_passphrase')
    expectConfigError(
      () => parseSubaccountSecrets(secret('binance', '\n    api_passphrase: p')),
      'unexpected_passphrase',
    )
  })
})

describe('selectSubaccount', () => {
  it('joins a registry row to its credentials on (exchange, strategy)', () => {
    const sub = selectSubaccount(sources, { exchange: 'kucoin', strategy: 's2' })
    expect(sub.subAccountLabel).toBe('strategy2kucoin')
    expect(sub.allocatedCapitalUsdt).toBe(100)
    expect(sub.secrets).toEqual({ apiKey: 'kc-key', apiSecret: 'kc-secret', apiPassphrase: 'kc-pass' })
  })

  it('serializes without secrets', () => {
    const sub = selectSubaccount(sources, { exchange: 'kucoin', strategy: 's2' })
    const json = JSON.stringify(sub)
    expect(json).not.toContain('kc-key')
    expect(json).not.toContain('kc-secret')
    expect(json).not.toContain('kc-pass')
    expect(JSON.parse(json)).toMatchObject({ exchange: 'kucoin', strategy: 's2', status: 'active' })
  })

  it('refuses an unknown pair and a pair with no credentials', () => {
    expectConfigError(() => selectSubaccount(sources, { exchange: 'binance', strategy: 's4-2a' }), 'unknown_subaccount')
    expectConfigError(() => selectSubaccount(sources, { exchange: 'okx', strategy: 's6' }), 'missing_secret')
  })

  it('refuses a non-active row before it can be traded', () => {
    const idle: SubaccountSources = {
      subaccountsYamlText: `
subaccounts:
  - exchange: okx
    strategy: s6
    sub_account_id: "sub-1"
    sub_account_label: "sub-1"
    allocated_capital_usdt: 0
    status: idle
`,
      secretsYamlText,
    }
    expectConfigError(() => selectSubaccount(idle, { exchange: 'okx', strategy: 's6' }), 'subaccount_inactive')
  })
})
