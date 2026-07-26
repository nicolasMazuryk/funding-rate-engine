/**
 * `npm run capture` — records real venue responses into committed fixtures (task
 * 0250; spec `0000` §5). Thin CLI over the per-venue capture drivers
 * (`src/capture/capture-{binance,bybit,okx,bitget,kucoin}.ts`); no test code imported (CLI must
 * not depend on `test/`).
 *
 *   npm run capture -- --venue binance|bybit|okx|bitget|kucoin \
 *     --set markets|public-ws|private-ws|orders [--count N] [--window-ms N] [--out DIR]
 *
 * `private-ws`/`orders` read testnet keys from env (`<VENUE>_TESTNET_API_KEY` /
 * `_SECRET`, plus `OKX_TESTNET_PASSPHRASE` / `BITGET_TESTNET_PASSPHRASE` on those venues, which sign with three
 * credentials) and fail loud, non-zero, when absent — mirrors the integration-gate
 * convention (skip loudly, never silently no-op). On **kucoin** those two sets fail loud
 * unconditionally: the venue has no sandbox, so capturing them would place a real live order —
 * the fixtures are hand-authored instead (`src/capture/capture-kucoin.ts`).
 *
 * A new venue is one entry in {@link DRIVERS} (data, not a branch): its driver module
 * exports the same four set functions with the same signatures.
 */

import dotenv from 'dotenv'
import * as binance from '../src/capture/capture-binance.js'
import * as bitget from '../src/capture/capture-bitget.js'
import * as bybit from '../src/capture/capture-bybit.js'
import * as kucoin from '../src/capture/capture-kucoin.js'
import * as okx from '../src/capture/capture-okx.js'

const SETS = ['markets', 'public-ws', 'private-ws', 'orders'] as const
type Set_ = (typeof SETS)[number]

/** One venue's capture driver — the four set functions, identical shape per venue. */
interface Driver {
  captureMarkets(outDir?: string): Promise<void>
  capturePublicWs(opts: { count?: number; windowMs?: number; outDir?: string }): Promise<void>
  capturePrivateWs(opts: { windowMs?: number; outDir?: string }): Promise<void>
  captureOrders(outDir?: string): Promise<void>
}

const DRIVERS: Record<string, Driver> = { binance, bybit, okx, bitget, kucoin }
const VENUES = Object.keys(DRIVERS)

const USAGE = [
  'Usage:',
  `  npm run capture -- --venue ${VENUES.join('|')} --set markets|public-ws|private-ws|orders`,
  '    [--count N] [--window-ms N] [--out DIR]',
].join('\n')

function fail(reason?: string): never {
  if (reason !== undefined) process.stderr.write(`capture: ${reason}\n`)
  process.stderr.write(`${USAGE}\n`)
  process.exit(1)
}

interface Args {
  readonly venue?: string
  readonly set?: Set_
  readonly count?: number
  readonly windowMs?: number
  readonly out?: string
}

function parseArgs(argv: readonly string[]): Args {
  let venue: string | undefined
  let set: Set_ | undefined
  let count: number | undefined
  let windowMs: number | undefined
  let out: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--venue':
        venue = argv[++i] ?? fail('--venue needs a value')
        break
      case '--set': {
        const value = argv[++i] ?? fail('--set needs a value')
        if (!(SETS as readonly string[]).includes(value)) fail(`--set must be one of: ${SETS.join(', ')}`)
        set = value as Set_
        break
      }
      case '--count': {
        const value = argv[++i] ?? fail('--count needs a value')
        count = Number.parseInt(value, 10)
        if (!Number.isFinite(count)) fail('--count must be a number')
        break
      }
      case '--window-ms': {
        const value = argv[++i] ?? fail('--window-ms needs a value')
        windowMs = Number.parseInt(value, 10)
        if (!Number.isFinite(windowMs)) fail('--window-ms must be a number')
        break
      }
      case '--out':
        out = argv[++i] ?? fail('--out needs a value')
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }
  return { venue, set, count, windowMs, out }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  // Credentials live in the workspace `.env` (gitignored), as `scripts/testnet.ts` reads them;
  // a real shell env var still wins, since dotenv never overwrites.
  dotenv.config({ quiet: true })
  if (args.venue === undefined) fail('--venue is required')
  const driver = DRIVERS[args.venue]
  if (driver === undefined) fail(`unsupported venue '${args.venue}' (one of: ${VENUES.join(', ')})`)
  if (args.set === undefined) fail('--set is required')

  switch (args.set) {
    case 'markets':
      await driver.captureMarkets(args.out)
      break
    case 'public-ws':
      await driver.capturePublicWs({ count: args.count, windowMs: args.windowMs, outDir: args.out })
      break
    case 'private-ws':
      await driver.capturePrivateWs({ windowMs: args.windowMs, outDir: args.out })
      break
    case 'orders':
      await driver.captureOrders(args.out)
      break
  }
  process.stdout.write(`capture: wrote ${args.set} fixtures\n`)
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
