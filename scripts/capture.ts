/**
 * `npm run capture` — records real venue responses into committed fixtures (task
 * 0250; spec `0000` §5). Thin CLI over `src/capture/capture-binance.ts`; no test
 * code imported (CLI must not depend on `test/`).
 *
 *   npm run capture -- --venue binance --set markets|public-ws|private-ws|orders \
 *     [--count N] [--window-ms N] [--out DIR]
 *
 * `private-ws`/`orders` read testnet keys from env (`BINANCE_TESTNET_API_KEY` /
 * `_SECRET`) and fail loud, non-zero, when absent — mirrors the integration-gate
 * convention (skip loudly, never silently no-op).
 */

import { captureMarkets, captureOrders, capturePrivateWs, capturePublicWs } from '../src/capture/capture-binance.js'

const SETS = ['markets', 'public-ws', 'private-ws', 'orders'] as const
type Set_ = (typeof SETS)[number]

const USAGE = [
  'Usage:',
  '  npm run capture -- --venue binance --set markets|public-ws|private-ws|orders',
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
  if (args.venue === undefined) fail('--venue is required')
  if (args.venue !== 'binance') fail(`unsupported venue '${args.venue}' (only 'binance' today)`)
  if (args.set === undefined) fail('--set is required')

  switch (args.set) {
    case 'markets':
      await captureMarkets(args.out)
      break
    case 'public-ws':
      await capturePublicWs({ count: args.count, windowMs: args.windowMs, outDir: args.out })
      break
    case 'private-ws':
      await capturePrivateWs({ windowMs: args.windowMs, outDir: args.out })
      break
    case 'orders':
      await captureOrders(args.out)
      break
  }
  process.stdout.write(`capture: wrote ${args.set} fixtures\n`)
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
