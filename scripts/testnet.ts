/**
 * `npm run test:testnet` — the third verification layer (task 0260; spec `0000` §3):
 * runs the full `17` §3 checklist against a venue's futures testnet with structured,
 * machine-readable pass/fail/skip output. Thin CLI over `src/testnet/`, mirroring
 * `scripts/capture.ts`'s idiom; no test code imported (CLI must not depend on `test/`).
 *
 *   npm run test:testnet -- --venue binance [--out PATH] [--json]
 *
 * Without testnet credentials, every check reports `skip: no credentials` and the
 * command exits 0 — a missing key is never a red build. With credentials, the exit
 * code is `exitCodeFor(summary)`: 1 iff any check failed (skips never fail the run).
 */

import { binanceTestnetChecks } from '../src/testnet/binance/registry.js'
import {
  createBinanceTestnetContext,
  hasBinanceTestnetCredentials,
  TESTNET_TOOL_VERSION,
} from '../src/testnet/context.js'
import { runChecks } from '../src/testnet/runner.js'
import { exitCodeFor, formatSummaryTable, writeSummary } from '../src/testnet/summary.js'
import type { TestnetSummary } from '../src/testnet/types.js'

const VENUES = ['binance'] as const
type Venue = (typeof VENUES)[number]

const USAGE = ['Usage:', '  npm run test:testnet -- --venue binance [--out PATH] [--json]'].join('\n')

function fail(reason?: string): never {
  if (reason !== undefined) process.stderr.write(`testnet: ${reason}\n`)
  process.stderr.write(`${USAGE}\n`)
  process.exit(1)
}

interface Args {
  readonly venue?: Venue
  readonly out?: string
  readonly json: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let venue: Venue | undefined
  let out: string | undefined
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--venue': {
        const value = argv[++i] ?? fail('--venue needs a value')
        if (!(VENUES as readonly string[]).includes(value)) fail(`--venue must be one of: ${VENUES.join(', ')}`)
        venue = value as Venue
        break
      }
      case '--out':
        out = argv[++i] ?? fail('--out needs a value')
        break
      case '--json':
        json = true
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }
  return { venue, out, json }
}

function defaultSummaryPath(venue: Venue): string {
  return `test/testnet/${venue}/summary.json`
}

/** All-skip summary emitted when no testnet credentials are present — exits 0, never red. */
function skippedSummary(venue: Venue, checkNames: readonly { name: string; specRef: string }[]): TestnetSummary {
  const nowMs = Date.now()
  const results = checkNames.map((c) => ({
    name: c.name,
    specRef: c.specRef,
    status: 'skip' as const,
    reason: 'no credentials',
    durationMs: 0,
  }))
  return {
    venue,
    network: 'testnet',
    toolVersion: TESTNET_TOOL_VERSION,
    startedAtMs: nowMs,
    durationMs: 0,
    total: results.length,
    passed: 0,
    failed: 0,
    skipped: results.length,
    results,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.venue === undefined) fail('--venue is required')
  const venue = args.venue

  const outPath = args.out ?? defaultSummaryPath(venue)

  let summary: TestnetSummary
  if (!hasBinanceTestnetCredentials()) {
    summary = skippedSummary(venue, binanceTestnetChecks)
  } else {
    const ctx = await createBinanceTestnetContext()
    summary = await runChecks(venue, TESTNET_TOOL_VERSION, binanceTestnetChecks, ctx, { now: () => Date.now() })
    await ctx.adapter.close()
  }

  writeSummary(outPath, summary)

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  } else {
    process.stdout.write(`${formatSummaryTable(summary)}\n`)
  }
  process.exit(exitCodeFor(summary))
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
