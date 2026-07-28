/**
 * The live-tier **verdict** (task 0470 phase 4) — a live run's self-interpretable artifact.
 *
 * A superset of the testnet {@link TestnetSummary}: the same per-check rows plus everything a
 * reader needs to judge a *real-money* run — which sub-account (secret-free), which ceilings,
 * how much exposure was reserved, what the cap refused, what it cost, and whether the account
 * was **verified flat** at the end.
 *
 * The exit rule is stricter than the testnet tier's in exactly one way: an all-pass run whose
 * teardown could not verify the account flat still exits `1`. Money left on a venue is a failed
 * run whatever the checks said. Fees over the suite bound likewise fail — an unexpectedly
 * expensive run means the tier did something other than what it thinks it did.
 */

import { writeJsonFixture } from '../capture/fixture-writer.js'
import type { SubaccountRow } from '../config/subaccounts.js'
import type { TestnetSummary } from '../testnet/types.js'
import { LIVE_SUITE_FEE_BOUND_USD, type LiveCaps, type LiveSuite } from './caps.js'
import type { CapRejection } from './notional-cap.js'
import type { TeardownReport } from './teardown.js'

/** The sub-account identity carried in the verdict — the registry row, never its credentials. */
export type LiveSubaccountIdentity = SubaccountRow

export interface LiveVerdict extends TestnetSummary {
  readonly suite: LiveSuite
  readonly subAccount: LiveSubaccountIdentity
  readonly caps: LiveCaps
  /** Non-reduce-only notional the cap reserved over the run, USD. */
  readonly exposureUsd: number
  readonly capRejections: readonly CapRejection[]
  /** Realized fees the checks observed, USD. */
  readonly feesUsd: number
  readonly feeBoundUsd: number
  /** Absent only when the run never built a context (all-skip). */
  readonly teardown?: TeardownReport
  readonly tracePath?: string
}

export interface BuildLiveVerdictInput {
  readonly summary: TestnetSummary
  readonly suite: LiveSuite
  readonly subAccount: LiveSubaccountIdentity
  readonly caps: LiveCaps
  readonly exposureUsd: number
  readonly capRejections: readonly CapRejection[]
  readonly feesUsd: number
  readonly teardown?: TeardownReport
  readonly tracePath?: string
}

export function buildLiveVerdict(input: BuildLiveVerdictInput): LiveVerdict {
  return {
    ...input.summary,
    suite: input.suite,
    subAccount: input.subAccount,
    caps: input.caps,
    exposureUsd: input.exposureUsd,
    capRejections: input.capRejections,
    feesUsd: input.feesUsd,
    feeBoundUsd: LIVE_SUITE_FEE_BOUND_USD[input.suite],
    ...(input.teardown === undefined ? {} : { teardown: input.teardown }),
    ...(input.tracePath === undefined ? {} : { tracePath: input.tracePath }),
  }
}

/**
 * `0` only for a run that is unambiguously fine: nothing failed, the account is provably flat,
 * and it cost no more than the suite's fee budget. An all-skip run (no credentials) is `0` — a
 * missing secrets file is never a red build, exactly as on the testnet tier. A run with no
 * checks at all is `1`: an empty suite is a misconfiguration, not a pass.
 */
export function liveExitCode(verdict: LiveVerdict): number {
  if (verdict.total === 0) return 1
  if (verdict.skipped === verdict.total) return 0
  if (verdict.failed > 0) return 1
  if (verdict.teardown === undefined || !verdict.teardown.verifiedFlat) return 1
  if (verdict.feesUsd > verdict.feeBoundUsd) return 1
  return 0
}

/** Human-readable verdict for stdout — the machine-readable copy stays in the JSON artifact. */
export function formatLiveVerdict(verdict: LiveVerdict): string {
  const flat =
    verdict.teardown === undefined ? 'teardown: not run' : `flat: ${verdict.teardown.verifiedFlat ? 'yes' : 'NO'}`
  const header =
    `live: ${verdict.venue}/${verdict.suite} on ${verdict.subAccount.subAccountLabel} — ` +
    `${verdict.passed} passed, ${verdict.failed} failed, ${verdict.skipped} skipped ` +
    `(${verdict.total} total, ${verdict.durationMs}ms)`
  const money =
    `  caps: ${verdict.caps.maxOrderNotionalUsd}/${verdict.caps.maxTotalNotionalUsd} USD · ` +
    `exposure ${verdict.exposureUsd.toFixed(2)} USD · cap rejections ${verdict.capRejections.length} · ` +
    `fees ${verdict.feesUsd.toFixed(4)}/${verdict.feeBoundUsd} USD · ${flat}`
  const rows = verdict.results.map((r) => {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP'
    const reason = r.reason !== undefined ? ` — ${r.reason}` : ''
    return `  [${tag}] ${r.name} (${r.specRef}, ${r.durationMs}ms)${reason}`
  })
  const manual =
    verdict.teardown !== undefined && !verdict.teardown.verifiedFlat
      ? [
          `  !! MANUAL INTERVENTION REQUIRED on ${verdict.venue} sub-account ` +
            `'${verdict.subAccount.subAccountLabel}' (${verdict.subAccount.subAccountId}): ` +
            `${verdict.teardown.openPositions.length} position(s), ${verdict.teardown.openOrders.length} order(s)`,
        ]
      : []
  const trace = verdict.tracePath === undefined ? [] : [`  trace: ${verdict.tracePath}`]
  return [header, money, ...rows, ...manual, ...trace].join('\n')
}

/** Write the verdict artifact (same deterministic writer the testnet summary uses). */
export function writeLiveVerdict(path: string, verdict: LiveVerdict): void {
  writeJsonFixture(path, verdict)
}
