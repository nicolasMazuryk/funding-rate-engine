/**
 * `.env` schema + parser (`09_configuration.md` §2). Identity + wiring + secrets.
 * Pure: takes an env record, returns a validated descriptor — the caller (task
 * 0110) runs `dotenv` and passes `process.env` in.
 *
 * Secrets are resolved dynamically off the selected `EXCHANGE`
 * (`${EXCHANGE}_API_KEY` / `_API_SECRET` required, `_API_PASSPHRASE` optional), so
 * an instance need only carry its own venue's credentials, not every venue's.
 */

import { z } from 'zod'
import { STRATEGY_IDS, type StrategyId } from './canonical.js'
import { ConfigParseError } from './errors.js'
import { zodErrorToConfigError } from './schema.js'

/** The in-repo adapters today (0190 Binance, 0420 Bybit, 0430 OKX); extend as 0440+ land (do not pre-populate). */
export const EXCHANGES = ['binance', 'bybit', 'okx'] as const
export type Exchange = (typeof EXCHANGES)[number]

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const
export const KILL_SWITCH_STATES = ['off', 'paused', 'flatten'] as const
export type KillSwitchState = (typeof KILL_SWITCH_STATES)[number]

export const EnvSchema = z.object({
  EXCHANGE: z.enum(EXCHANGES),
  STRATEGY: z.enum([...STRATEGY_IDS]),
  SUBACCOUNT: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  KILL_SWITCH: z.enum(KILL_SWITCH_STATES).default('off'),
})

export interface ParsedEnv {
  readonly exchange: Exchange
  readonly strategy: StrategyId
  readonly subaccount: string
  readonly databaseUrl: string
  readonly logLevel: (typeof LOG_LEVELS)[number]
  readonly killSwitch: KillSwitchState
  readonly secrets: { readonly apiKey: string; readonly apiSecret: string; readonly apiPassphrase?: string }
}

export function parseEnv(env: Record<string, string | undefined>): ParsedEnv {
  const res = EnvSchema.safeParse(env)
  if (!res.success) throw zodErrorToConfigError(res.error, 'env')
  const e = res.data

  const prefix = e.EXCHANGE.toUpperCase()
  const rawPassphrase = env[`${prefix}_API_PASSPHRASE`]
  const secrets = z
    .object({
      apiKey: z.string().min(1),
      apiSecret: z.string().min(1),
      apiPassphrase: z.string().min(1).optional(),
    })
    .safeParse({
      apiKey: env[`${prefix}_API_KEY`],
      apiSecret: env[`${prefix}_API_SECRET`],
      apiPassphrase: rawPassphrase === '' ? undefined : rawPassphrase,
    })
  if (!secrets.success) {
    throw new ConfigParseError(
      `env.${prefix}_API_KEY / ${prefix}_API_SECRET`,
      `missing or empty required secret(s) for exchange '${e.EXCHANGE}'`,
      'missing_secret',
    )
  }

  return {
    exchange: e.EXCHANGE,
    strategy: e.STRATEGY,
    subaccount: e.SUBACCOUNT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    killSwitch: e.KILL_SWITCH,
    secrets: secrets.data,
  }
}
