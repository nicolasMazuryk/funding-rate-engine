/**
 * Testnet-tier harness types (task 0260; spec `17_testing.md` §3). One `Check` per
 * checklist bullet; `runChecks` (`./runner.ts`) drives them serially into one
 * machine-readable {@link TestnetSummary}. Venue-neutral — `src/testnet/binance/`
 * is the first consumer; 0420–0460 copy the shape for the other five venues.
 */

/** Terminal per-check verdict. A thrown check always becomes `fail`. */
export type CheckStatus = 'pass' | 'fail' | 'skip'

/** What a check's `run` resolves to when it does not throw. */
export interface CheckOutcome {
  readonly status: 'pass' | 'skip'
  /** Required for `skip` (e.g. "no credentials", "unfunded"); optional context for `pass`. */
  readonly reason?: string
  readonly detail?: unknown
}

/** One row of the JSON summary artifact. */
export interface CheckResult {
  readonly name: string
  readonly specRef: string
  readonly status: CheckStatus
  readonly reason?: string
  readonly durationMs: number
  readonly detail?: unknown
}

/**
 * Base context every check receives. Venue registries extend this with their own
 * adapter/clients. `onCleanup` registers a teardown that always runs after this
 * check, in `finally` — so a mid-check throw still cancels a resting order.
 */
export interface CheckContext {
  readonly hasCredentials: boolean
  onCleanup(fn: () => Promise<void>): void
}

/** One `17` §3 checklist bullet. */
export interface Check<Ctx extends CheckContext = CheckContext> {
  readonly name: string
  readonly specRef: string
  run(ctx: Ctx): Promise<CheckOutcome>
}

/**
 * Which environment the run actually hit. Four venues have a sandbox (a domain, a flag or a
 * header) and report `testnet`; KuCoin has none at all (task 0460), so its read-only tier runs
 * against **live production with live keys** and must say so — a summary claiming `testnet`
 * there would be a false record of what the run touched.
 */
export type TestnetNetwork = 'testnet' | 'live-readonly'

/** The JSON summary artifact — self-interpretable pass/fail/skip result (spec `0000` §3). */
export interface TestnetSummary {
  readonly venue: string
  readonly network: TestnetNetwork
  readonly toolVersion: string
  readonly startedAtMs: number
  readonly durationMs: number
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly results: readonly CheckResult[]
}
