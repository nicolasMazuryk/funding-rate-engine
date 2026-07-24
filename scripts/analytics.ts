/**
 * `npm run analytics` — the trade-analytics + fleet-rollup report (task 0410; `15` §4/§5).
 *
 * Read-only: it opens its own pool against `DATABASE_URL`, runs the `src/analytics/`
 * queries, prints a table (or `--json`), and exits. No engine, no orders, no writes.
 *
 *   npm run analytics -- [--json] [--exchange <id>] [--strategy <id>] [--subaccount <id>]
 *                        [--from <ms>] [--to <ms>]
 *
 * With no filters it reports the whole fleet, all time. `--from`/`--to` are epoch ms UTC
 * (`00_globals` §1.2). Exit 0 on success, 1 on bad args or a query error.
 *
 * Unlike `npm start` this deliberately does NOT load the full effective config: a report
 * needs no API credentials, so it reads `DATABASE_URL` from the environment and the taker
 * fee (the S1-WS kill threshold's `fees` term) from `config/exchanges.yaml`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { runAnalytics, toJson, toTable } from '../src/analytics/index.js'
import { STRATEGY_IDS, type StrategyId } from '../src/config/canonical.js'
import { parseExchangeProfiles } from '../src/config/exchange-schema.js'

const DEFAULT_EXCHANGE = 'binance'

const USAGE = [
  'Usage:',
  '  npm run analytics -- [--json] [--exchange <id>] [--strategy <id>] [--subaccount <id>] [--from <ms>] [--to <ms>]',
].join('\n')

/** Fail loud: reason + usage to stderr, exit 1 (mirrors `scripts/replay.ts`). */
function fail(reason?: string): never {
  if (reason !== undefined) process.stderr.write(`analytics: ${reason}\n`)
  process.stderr.write(`${USAGE}\n`)
  process.exit(1)
}

interface Args {
  readonly json: boolean
  readonly exchange?: string
  readonly strategy?: StrategyId
  readonly subaccount?: string
  readonly fromMs?: number
  readonly toMs?: number
}

/** Epoch-ms argument: an unparseable or non-integer value is a loader error, not a 0. */
function parseMs(flag: string, raw: string | undefined): number {
  const value = Number(raw ?? fail(`${flag} needs an epoch-ms value`))
  if (!Number.isInteger(value)) fail(`${flag} must be an integer epoch-ms timestamp, got '${raw}'`)
  return value
}

function parseArgs(argv: readonly string[]): Args {
  let json = false
  let exchange: string | undefined
  let strategy: StrategyId | undefined
  let subaccount: string | undefined
  let fromMs: number | undefined
  let toMs: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--json':
        json = true
        break
      case '--exchange':
        exchange = argv[++i] ?? fail('--exchange needs a value')
        break
      case '--strategy': {
        const value = argv[++i] ?? fail('--strategy needs a value')
        if (!(STRATEGY_IDS as readonly string[]).includes(value)) {
          fail(`--strategy must be one of: ${STRATEGY_IDS.join(', ')}`)
        }
        strategy = value as StrategyId
        break
      }
      case '--subaccount':
        subaccount = argv[++i] ?? fail('--subaccount needs a value')
        break
      case '--from':
        fromMs = parseMs('--from', argv[++i])
        break
      case '--to':
        toMs = parseMs('--to', argv[++i])
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) fail('--from must not be after --to')
  return { json, exchange, strategy, subaccount, fromMs, toMs }
}

/** Taker fee (percent) for the reported exchange, from the venue profiles (`09` §4). */
function takerFeePctFor(exchange: string): number {
  const text = readFileSync(resolve(process.cwd(), 'config/exchanges.yaml'), 'utf8')
  const profile = parseExchangeProfiles(text)[exchange as keyof ReturnType<typeof parseExchangeProfiles>]
  if (profile === undefined) fail(`no exchange profile for '${exchange}' in config/exchanges.yaml`)
  return profile.takerFeePct
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  dotenv.config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') fail('DATABASE_URL is not set')

  const query = {
    ...(args.exchange !== undefined ? { exchange: args.exchange } : {}),
    ...(args.strategy !== undefined ? { strategy: args.strategy } : {}),
    ...(args.subaccount !== undefined ? { subaccount: args.subaccount } : {}),
    ...(args.fromMs !== undefined ? { fromMs: args.fromMs } : {}),
    ...(args.toMs !== undefined ? { toMs: args.toMs } : {}),
  }

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const report = await runAnalytics(drizzle(pool), {
      query,
      takerFeePct: takerFeePctFor(args.exchange ?? DEFAULT_EXCHANGE),
    })
    process.stdout.write(args.json ? `${toJson(report)}\n` : `${toTable(report)}\n`)
  } finally {
    await pool.end()
  }
  process.exit(0)
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
