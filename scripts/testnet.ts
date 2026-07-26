/**
 * `npm run test:testnet` — the third verification layer (task 0260; spec `0000` §3):
 * runs the full `17` §3 checklist against a venue's futures testnet with structured,
 * machine-readable pass/fail/skip output. Thin CLI over `src/testnet/`, mirroring
 * `scripts/capture.ts`'s idiom; no test code imported (CLI must not depend on `test/`).
 *
 *   npm run test:testnet -- --venue <binance|bybit|okx|bitget|kucoin> [--out PATH] [--json]
 *
 * Without testnet credentials, every check reports `skip: no credentials` and the
 * command exits 0 — a missing key is never a red build. With credentials, the exit
 * code is `exitCodeFor(summary)`: 1 iff any check failed (skips never fail the run).
 * Neither OKX nor Bitget has a testnet domain — `--venue okx` / `--venue bitget` run against
 * **demo trading**, a flag on the production host (`OKX_TESTNET_*` / `BITGET_TESTNET_*`,
 * passphrase included on both). KuCoin has no sandbox in any form, so `--venue kucoin` is a
 * **read-only tier against live production** and its summary records `network: 'live-readonly'`
 * rather than claiming a testnet run.
 *
 * Adding a venue (0420 Bybit, 0430 OKX, 0440 Bitget, 0460 KuCoin) is one {@link VENUE_REGISTRY}
 * entry — its check registry, its context builder, its credential probe and (only where it is
 * not a testnet) its network label. The CLI stays venue-agnostic: data, not a branch.
 */

import dotenv from 'dotenv'
import type { ExchangeAdapter } from '../src/core/ports/exchange-adapter.js'
import { binanceTestnetChecks } from '../src/testnet/binance/registry.js'
import { bitgetTestnetChecks } from '../src/testnet/bitget/registry.js'
import { bybitTestnetChecks } from '../src/testnet/bybit/registry.js'
import {
  createBinanceTestnetContext,
  createBitgetTestnetContext,
  createBybitTestnetContext,
  createKucoinTestnetContext,
  createOkxTestnetContext,
  hasBinanceTestnetCredentials,
  hasBitgetTestnetCredentials,
  hasBybitTestnetCredentials,
  hasKucoinCredentials,
  hasOkxTestnetCredentials,
  TESTNET_TOOL_VERSION,
} from '../src/testnet/context.js'
import { kucoinReadOnlyChecks } from '../src/testnet/kucoin/registry.js'
import { okxTestnetChecks } from '../src/testnet/okx/registry.js'
import { runChecks } from '../src/testnet/runner.js'
import { exitCodeFor, formatSummaryTable, writeSummary } from '../src/testnet/summary.js'
import type { Check, CheckContext, TestnetNetwork, TestnetSummary } from '../src/testnet/types.js'

const VENUES = ['binance', 'bybit', 'okx', 'bitget', 'kucoin'] as const
type Venue = (typeof VENUES)[number]

const USAGE = ['Usage:', `  npm run test:testnet -- --venue <${VENUES.join('|')}> [--out PATH] [--json]`].join('\n')

/**
 * One venue's testnet tier, with its context type already bound: the CLI only needs the
 * check names (for the all-skip summary) and a way to run the credentialed suite. A venue's
 * checks and its context are matched by construction — {@link venueEntry} is where the two
 * meet, so nothing downstream has to be generic over the venue.
 */
interface VenueEntry {
  readonly checks: readonly { readonly name: string; readonly specRef: string }[]
  /** What this venue's tier hits — `live-readonly` on KuCoin, which has no sandbox at all. */
  readonly network: TestnetNetwork
  hasCredentials(): boolean
  run(venue: Venue): Promise<TestnetSummary>
}

function venueEntry<Ctx extends CheckContext & { readonly adapter: ExchangeAdapter }>(entry: {
  readonly checks: readonly Check<Ctx>[]
  readonly createContext: () => Promise<Ctx>
  readonly hasCredentials: () => boolean
  /** Defaults to `testnet`; only KuCoin overrides it. */
  readonly network?: TestnetNetwork
}): VenueEntry {
  const network = entry.network ?? 'testnet'
  return {
    checks: entry.checks,
    network,
    hasCredentials: entry.hasCredentials,
    async run(venue: Venue): Promise<TestnetSummary> {
      const ctx = await entry.createContext()
      try {
        return await runChecks(venue, TESTNET_TOOL_VERSION, entry.checks, ctx, { now: () => Date.now(), network })
      } finally {
        await ctx.adapter.close() // sockets/timers down even if the runner itself blew up
      }
    },
  }
}

const VENUE_REGISTRY: Record<Venue, VenueEntry> = {
  binance: venueEntry({
    checks: binanceTestnetChecks,
    createContext: createBinanceTestnetContext,
    hasCredentials: hasBinanceTestnetCredentials,
  }),
  bybit: venueEntry({
    checks: bybitTestnetChecks,
    createContext: createBybitTestnetContext,
    hasCredentials: hasBybitTestnetCredentials,
  }),
  // OKX has no separate testnet: `--venue okx` runs against **demo trading**, a flag on the
  // same account's keys (plus the passphrase the credential probe also requires).
  okx: venueEntry({
    checks: okxTestnetChecks,
    createContext: createOkxTestnetContext,
    hasCredentials: hasOkxTestnetCredentials,
  }),
  // Bitget has no separate testnet either: `--venue bitget` runs against **demo trading**, a
  // header on the same host (`PAPTRADING`), with its own demo-only keys + passphrase. The
  // account must be a Unified Trading Account — the adapter speaks only the v3/UTA surface.
  bitget: venueEntry({
    checks: bitgetTestnetChecks,
    createContext: createBitgetTestnetContext,
    hasCredentials: hasBitgetTestnetCredentials,
  }),
  // KuCoin has no sandbox in any form (decommissioned; `setSandboxMode` fails silently), so
  // `--venue kucoin` runs a **read-only** six-check tier against live production with live keys
  // — hence `network: 'live-readonly'` in the summary and the extra `KUCOIN_LIVE_READONLY=1`
  // opt-in in its credential probe. No order path, no cancels, no flatten (`src/testnet/kucoin/`).
  kucoin: venueEntry({
    checks: kucoinReadOnlyChecks,
    createContext: createKucoinTestnetContext,
    hasCredentials: hasKucoinCredentials,
    network: 'live-readonly',
  }),
}

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
function skippedSummary(
  venue: Venue,
  network: TestnetNetwork,
  checkNames: readonly { name: string; specRef: string }[],
): TestnetSummary {
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
    network,
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
  // Credentials live in the workspace `.env` (gitignored), as `scripts/analytics.ts` reads
  // `DATABASE_URL`; a real shell env var still wins, since dotenv never overwrites.
  dotenv.config({ quiet: true })
  if (args.venue === undefined) fail('--venue is required')
  const venue = args.venue

  const outPath = args.out ?? defaultSummaryPath(venue)

  const entry = VENUE_REGISTRY[venue]
  const summary: TestnetSummary = entry.hasCredentials()
    ? await entry.run(venue)
    : skippedSummary(venue, entry.network, entry.checks)

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
