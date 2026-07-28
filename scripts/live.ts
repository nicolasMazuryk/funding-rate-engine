/**
 * `npm run test:live` — the fourth verification layer (task 0470; spec `0000` §3): real orders
 * on a **production** venue with real money, bounded by the compiled-in caps (`src/live/caps.ts`).
 * Thin CLI over `src/live/`, mirroring `scripts/testnet.ts`'s idiom; no test code imported.
 *
 *   npm run test:live -- --subaccount <strategy-id> [--venue <v> | --all-venues]
 *                        [--suite <self-test|fill-test|funding-test>] [--parallel]
 *                        [--out PATH] [--json]
 *
 * Venues run one at a time by default. `--parallel` runs them at once, which `funding-test`
 * needs: its window is a single settlement boundary, and serially the five venues would need
 * five of them. Nothing is shared between venues but the process — different exchange,
 * sub-account and credentials each — and a signal tears all of them down concurrently.
 *
 * `--subaccount` is **required and has no default**: every run must name the sub-account it is
 * about to trade (`config/subaccounts.yaml`), because the failure this tier most needs to
 * prevent is placing real orders on the wrong account. Without the gitignored credentials file
 * every check reports `skip: no live credentials` and the command exits 0 — a machine without
 * live keys is never a red build.
 *
 * Teardown is unconditional. It runs in `finally` **and** from `SIGINT`/`SIGTERM`, and the
 * teardown itself is memoized, so a Ctrl-C during a resting order flattens the account rather
 * than orphaning it. If teardown cannot finish inside {@link TEARDOWN_TIMEOUT_MS}, the CLI says
 * MANUAL INTERVENTION and names the sub-account — the one case where a human must act.
 */

import { STRATEGY_IDS, type StrategyId } from '../src/config/canonical.js'
import { EXCHANGE_IDS, type ExchangeId } from '../src/config/exchange-schema.js'
import { hasSubaccountSecrets } from '../src/config/subaccounts.js'
import { LIVE_SUITES, type LiveSuite, resolveCaps } from '../src/live/caps.js'
import { createLiveContext, LIVE_TOOL_VERSION, type LiveContext } from '../src/live/context.js'
import { LIVE_SUITE_CHECKS, type LiveCheck } from '../src/live/registry.js'
import {
  buildLiveVerdict,
  formatLiveVerdict,
  type LiveVerdict,
  liveExitCode,
  writeLiveVerdict,
} from '../src/live/verdict.js'
import { runChecks, withTimeout } from '../src/testnet/runner.js'
import type { TestnetSummary } from '../src/testnet/types.js'

/** How long a signal-triggered teardown may take before a human has to finish the job. */
const TEARDOWN_TIMEOUT_MS = 30_000

const USAGE = [
  'Usage:',
  `  npm run test:live -- --subaccount <${STRATEGY_IDS.join('|')}> [--venue <${EXCHANGE_IDS.join('|')}> | --all-venues]`,
  `                       [--suite <${LIVE_SUITES.join('|')}>] [--parallel] [--out PATH] [--json]`,
].join('\n')

function fail(reason?: string): never {
  if (reason !== undefined) process.stderr.write(`live: ${reason}\n`)
  process.stderr.write(`${USAGE}\n`)
  process.exit(1)
}

interface Args {
  readonly venues: readonly ExchangeId[]
  readonly suite: LiveSuite
  readonly strategy?: StrategyId
  readonly out?: string
  readonly json: boolean
  /** Run every selected venue at once rather than one after another. */
  readonly parallel: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let venue: ExchangeId | undefined
  let allVenues = false
  let suite: LiveSuite = 'self-test'
  let strategy: StrategyId | undefined
  let out: string | undefined
  let json = false
  let parallel = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--venue': {
        const value = argv[++i] ?? fail('--venue needs a value')
        if (!(EXCHANGE_IDS as readonly string[]).includes(value))
          fail(`--venue must be one of: ${EXCHANGE_IDS.join(', ')}`)
        venue = value as ExchangeId
        break
      }
      case '--all-venues':
        allVenues = true
        break
      case '--suite': {
        const value = argv[++i] ?? fail('--suite needs a value')
        if (!(LIVE_SUITES as readonly string[]).includes(value))
          fail(`--suite must be one of: ${LIVE_SUITES.join(', ')}`)
        suite = value as LiveSuite
        break
      }
      case '--subaccount': {
        const value = argv[++i] ?? fail('--subaccount needs a value')
        if (!(STRATEGY_IDS as readonly string[]).includes(value)) {
          fail(`--subaccount must be a strategy id: ${STRATEGY_IDS.join(', ')}`)
        }
        strategy = value as StrategyId
        break
      }
      case '--out':
        out = argv[++i] ?? fail('--out needs a value')
        break
      case '--json':
        json = true
        break
      case '--parallel':
        parallel = true
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }

  if (venue !== undefined && allVenues) fail('--venue and --all-venues are mutually exclusive')
  if (venue === undefined && !allVenues) fail('--venue (or --all-venues) is required')
  const venues = allVenues ? EXCHANGE_IDS : [venue as ExchangeId]
  return { venues, suite, strategy, out, json, parallel }
}

function verdictPath(venue: ExchangeId, suite: LiveSuite): string {
  return `test/live/${venue}/${suite}.json`
}

function tracePath(venue: ExchangeId, suite: LiveSuite): string {
  return `test/live/${venue}/${suite}.trace.jsonl`
}

/** The identity used by a verdict that never reached the registry (no credentials on this box). */
function unknownSubaccount(venue: ExchangeId, strategy: StrategyId): LiveVerdict['subAccount'] {
  return {
    exchange: venue,
    strategy,
    subAccountId: '(unknown)',
    subAccountLabel: '(no credentials)',
    allocatedCapitalUsdt: 0,
    status: 'idle',
  }
}

/** All-skip verdict emitted when the gitignored credentials file is absent — exits 0, never red. */
function skippedVerdict(venue: ExchangeId, args: Args, checks: readonly LiveCheck[]): LiveVerdict {
  const nowMs = Date.now()
  const reason = 'no live credentials (config/subaccounts.secrets.yaml absent)'
  const results = checks.map((c) => ({
    name: c.name,
    specRef: c.specRef,
    status: 'skip' as const,
    reason,
    durationMs: 0,
  }))
  const summary: TestnetSummary = {
    venue,
    network: 'prod',
    toolVersion: LIVE_TOOL_VERSION,
    startedAtMs: nowMs,
    durationMs: 0,
    total: results.length,
    passed: 0,
    failed: 0,
    skipped: results.length,
    results,
  }
  return buildLiveVerdict({
    summary,
    suite: args.suite,
    subAccount: unknownSubaccount(venue, args.strategy as StrategyId),
    caps: resolveCaps(),
    exposureUsd: 0,
    capRejections: [],
    feesUsd: 0,
  })
}

/**
 * The contexts currently in flight — what a signal handler must tear down. A set rather than a
 * single slot because `--parallel` runs several venues at once; each still owns its own
 * sub-account, so their teardowns never contend.
 */
const inFlight = new Set<LiveContext>()

/**
 * Best-effort teardown under a hard deadline. Returns the report when it finished in time;
 * on a timeout (or a throw) it prints the one line a human has to act on and returns undefined.
 */
async function teardownOrShout(ctx: LiveContext, reason: string): Promise<void> {
  try {
    const report = await withTimeout(ctx.teardown.run(reason), TEARDOWN_TIMEOUT_MS, 'live teardown')
    ctx.state.teardown = report
    if (report.verifiedFlat) return
  } catch (err) {
    process.stderr.write(`live: teardown (${reason}) failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  process.stderr.write(
    `live: !! MANUAL INTERVENTION REQUIRED — ${ctx.venue} sub-account '${ctx.subaccount.subAccountLabel}' ` +
      `(${ctx.subaccount.subAccountId}) could not be verified flat; check the account by hand\n`,
  )
}

/** Run one venue's suite end to end. Always tears down, whatever the checks did. */
async function runVenue(venue: ExchangeId, args: Args, checks: readonly LiveCheck[]): Promise<LiveVerdict> {
  const strategy = args.strategy as StrategyId
  const log = (message: string, meta?: Record<string, unknown>): void => {
    process.stderr.write(`live: ${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}\n`)
  }
  const trace = tracePath(venue, args.suite)
  const ctx = await createLiveContext(venue, { strategy, suite: args.suite, tracePath: trace, log })
  inFlight.add(ctx)

  let summary: TestnetSummary
  try {
    summary = await runChecks(venue, LIVE_TOOL_VERSION, checks, ctx, { now: () => Date.now(), network: 'prod' })
  } finally {
    // Unconditional: `assert-flat` already ran this exact teardown (memoized), so the normal
    // path pays nothing — but a suite that threw before reaching it still ends flat.
    await teardownOrShout(ctx, 'suite-end')
    await ctx.close()
    inFlight.delete(ctx)
  }

  return buildLiveVerdict({
    summary,
    suite: args.suite,
    subAccount: ctx.subaccount,
    caps: ctx.caps,
    exposureUsd: ctx.adapter.cap.exposureUsd(),
    capRejections: ctx.adapter.cap.rejections,
    feesUsd: ctx.state.feesUsd,
    ...(ctx.state.teardown === undefined ? {} : { teardown: ctx.state.teardown }),
    tracePath: trace,
  })
}

function report(verdict: LiveVerdict, args: Args): number {
  writeLiveVerdict(args.out ?? verdictPath(verdict.venue as ExchangeId, verdict.suite), verdict)
  process.stdout.write(args.json ? `${JSON.stringify(verdict)}\n` : `${formatLiveVerdict(verdict)}\n`)
  return liveExitCode(verdict)
}

/**
 * On `SIGINT`/`SIGTERM`: flatten what this run opened, emit the partial verdict, exit 1. A
 * signal during a live run is never a clean exit — there may be a resting order or an open
 * position, and the operator needs to see the teardown's outcome.
 */
function installSignalHandlers(args: Args): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        process.stderr.write(`live: ${signal} received — tearing down\n`)
        // Concurrently: under `--parallel` every open sub-account has to be flattened, and one
        // slow venue must not delay another's teardown past the 30 s deadline.
        await Promise.all(
          [...inFlight].map(async (ctx) => {
            await teardownOrShout(ctx, signal)
            report(
              buildLiveVerdict({
                summary: {
                  venue: ctx.venue,
                  network: 'prod',
                  toolVersion: LIVE_TOOL_VERSION,
                  startedAtMs: Date.now(),
                  durationMs: 0,
                  total: 0,
                  passed: 0,
                  failed: 0,
                  skipped: 0,
                  results: [],
                },
                suite: ctx.suite,
                subAccount: ctx.subaccount,
                caps: ctx.caps,
                exposureUsd: ctx.adapter.cap.exposureUsd(),
                capRejections: ctx.adapter.cap.rejections,
                feesUsd: ctx.state.feesUsd,
                ...(ctx.state.teardown === undefined ? {} : { teardown: ctx.state.teardown }),
                tracePath: ctx.tracePath,
              }),
              args,
            )
          }),
        )
        process.exit(1)
      })()
    })
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.strategy === undefined) fail('--subaccount is required — name the sub-account this run may trade')

  const checks = LIVE_SUITE_CHECKS[args.suite]
  if (checks.length === 0) fail(`suite '${args.suite}' has no checks yet (task 0470 phases 6–7)`)

  installSignalHandlers(args)

  const runOne = async (venue: ExchangeId): Promise<number> =>
    report(hasSubaccountSecrets() ? await runVenue(venue, args, checks) : skippedVerdict(venue, args, checks), args)

  let exitCode = 0
  if (args.parallel) {
    // Every venue is a different exchange, a different sub-account and a different set of
    // credentials, so nothing is shared but the process. `funding-test` needs this: its window
    // is one settlement boundary, and serially the five venues would need five of them.
    const codes = await Promise.all(args.venues.map(runOne))
    exitCode = Math.max(0, ...codes)
  } else {
    for (const venue of args.venues) {
      // Serial by default: one venue at a time, so a teardown is never racing another venue's
      // orders and a Ctrl-C has exactly one account to clean up.
      exitCode = Math.max(exitCode, await runOne(venue))
    }
  }
  process.exit(exitCode)
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
