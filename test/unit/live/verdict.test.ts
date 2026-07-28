/**
 * Unit: the live-tier **verdict** (task 0470 phase 4).
 *
 * The exit rule is the whole point: a live run is green only when nothing failed, the account
 * is **provably flat**, and the run cost no more than its suite's fee budget. All-pass-but-not-
 * flat is red — money left on a venue is a failed run. And the verdict must never carry a
 * credential: `subAccount` is the secret-free registry row.
 */

import { describe, expect, it } from 'vitest'
import { selectSubaccount } from '../../../src/config/subaccounts.js'
import { LIVE_SUITE_FEE_BOUND_USD, resolveCaps } from '../../../src/live/caps.js'
import type { TeardownReport } from '../../../src/live/teardown.js'
import { buildLiveVerdict, formatLiveVerdict, liveExitCode } from '../../../src/live/verdict.js'
import type { CheckResult, TestnetSummary } from '../../../src/testnet/types.js'

const SUBACCOUNT = {
  exchange: 'kucoin' as const,
  strategy: 's6' as const,
  subAccountId: '4711',
  subAccountLabel: 'kucoin-s6',
  allocatedCapitalUsdt: 100,
  status: 'active' as const,
}

function summary(results: readonly CheckResult[]): TestnetSummary {
  return {
    venue: 'kucoin',
    network: 'prod',
    toolVersion: '1',
    startedAtMs: 1_700_000_000_000,
    durationMs: 1_234,
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    results,
  }
}

function row(name: string, status: CheckResult['status']): CheckResult {
  return { name, specRef: '0470', status, durationMs: 1 }
}

function teardown(overrides: Partial<TeardownReport> = {}): TeardownReport {
  return {
    reason: 'suite-end',
    startedAtMs: 1_700_000_000_000,
    durationMs: 10,
    cancelled: [],
    flattened: [],
    residuals: [],
    openPositions: [],
    openOrders: [],
    verifiedFlat: true,
    errors: [],
    ...overrides,
  }
}

function verdict(
  results: readonly CheckResult[],
  extra: Partial<Parameters<typeof buildLiveVerdict>[0]> = {},
): ReturnType<typeof buildLiveVerdict> {
  return buildLiveVerdict({
    summary: summary(results),
    suite: 'self-test',
    subAccount: SUBACCOUNT,
    caps: resolveCaps(),
    exposureUsd: 4.2,
    capRejections: [],
    feesUsd: 0,
    teardown: teardown(),
    tracePath: 'test/live/kucoin/self-test.trace.jsonl',
    ...extra,
  })
}

describe('liveExitCode (0470 phase 4)', () => {
  it('is 0 for an all-pass, verified-flat, within-budget run', () => {
    expect(liveExitCode(verdict([row('subaccount-preflight', 'pass'), row('assert-flat', 'pass')]))).toBe(0)
  })

  it('is 1 when any check failed', () => {
    expect(liveExitCode(verdict([row('order-lifecycle', 'fail'), row('assert-flat', 'pass')]))).toBe(1)
  })

  it('is 1 when every check passed but the account is not verified flat', () => {
    const v = verdict([row('assert-flat', 'pass')], { teardown: teardown({ verifiedFlat: false }) })
    expect(liveExitCode(v)).toBe(1)
  })

  it('is 1 when teardown never ran at all', () => {
    const v = buildLiveVerdict({
      summary: summary([row('order-lifecycle', 'pass')]),
      suite: 'self-test',
      subAccount: SUBACCOUNT,
      caps: resolveCaps(),
      exposureUsd: 0,
      capRejections: [],
      feesUsd: 0,
    })
    expect(liveExitCode(v)).toBe(1)
  })

  it('is 1 when realized fees exceed the suite bound', () => {
    const over = LIVE_SUITE_FEE_BOUND_USD['self-test'] + 0.01
    expect(liveExitCode(verdict([row('assert-flat', 'pass')], { feesUsd: over }))).toBe(1)
    expect(
      liveExitCode(verdict([row('assert-flat', 'pass')], { feesUsd: LIVE_SUITE_FEE_BOUND_USD['self-test'] })),
    ).toBe(0)
  })

  it('is 0 for an all-skip run (no credentials is never a red build)', () => {
    const v = buildLiveVerdict({
      summary: summary([row('subaccount-preflight', 'skip'), row('assert-flat', 'skip')]),
      suite: 'self-test',
      subAccount: SUBACCOUNT,
      caps: resolveCaps(),
      exposureUsd: 0,
      capRejections: [],
      feesUsd: 0,
    })
    expect(liveExitCode(v)).toBe(0)
  })

  it('is 1 for a run with no checks at all — an empty suite is a misconfiguration', () => {
    expect(liveExitCode(verdict([]))).toBe(1)
  })
})

describe('formatLiveVerdict', () => {
  it('names the sub-account to act on when the account is not flat', () => {
    const text = formatLiveVerdict(
      verdict([row('assert-flat', 'fail')], {
        teardown: teardown({ verifiedFlat: false, openPositions: [{ symbol: 'DOGE', side: 'long', qty: 25 }] }),
      }),
    )
    expect(text).toContain('MANUAL INTERVENTION REQUIRED')
    expect(text).toContain('kucoin-s6')
    expect(text).toContain('4711')
  })

  it('reports caps, exposure and fees on one line', () => {
    const text = formatLiveVerdict(verdict([row('assert-flat', 'pass')]))
    expect(text).toContain('caps: 25/50 USD')
    expect(text).toContain('exposure 4.20 USD')
    expect(text).toContain('flat: yes')
  })
})

describe('verdict secrecy', () => {
  it('carries the registry row, never a credential', () => {
    const subaccounts = [
      'subaccounts:',
      '  - exchange: kucoin',
      '    strategy: strategy_6',
      '    sub_account_id: "4711"',
      '    sub_account_label: kucoin-s6',
      '    allocated_capital_usdt: 100',
      '    status: active',
    ].join('\n')
    const secrets = [
      'secrets:',
      '  - exchange: kucoin',
      '    strategy: strategy_6',
      '    api_key: KEY-DO-NOT-LEAK',
      '    api_secret: SECRET-DO-NOT-LEAK',
      '    api_passphrase: PASS-DO-NOT-LEAK',
    ].join('\n')
    const loaded = selectSubaccount(
      { subaccountsYamlText: subaccounts, secretsYamlText: secrets },
      { exchange: 'kucoin', strategy: 's6' },
    )

    const serialized = JSON.stringify(verdict([row('assert-flat', 'pass')], { subAccount: loaded.toJSON() }))
    expect(serialized).toContain('kucoin-s6')
    expect(serialized).not.toContain('DO-NOT-LEAK')
  })
})
