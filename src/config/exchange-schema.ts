/**
 * Exchange-profile schema (`09_configuration.md` §4). Static, venue-level facts —
 * fees, stagger, rate-limit reserve, WS endpoints — plus the per-exchange deltas
 * (`00_globals.md` §6) merged into effective config after base validation.
 *
 * String in, frozen camelCase object out — pure, no `fs` (the disk read lives in
 * `load.ts`). Any violation surfaces as a `ConfigParseError`, never a raw ZodError.
 *
 * Deviations from the spec's literal §4 example, recorded per this task's judgment:
 *  - `ws_order_adapter: boolean` is a static per-profile field (venue *capability*,
 *    08 §6), not a delta — the WS-mandatory guard is then pure data.
 *  - Leverage delta is nested `leverage: { s1: 4 }` (`Partial<Record<StrategyId,int>>`)
 *    rather than the spec's flat `leverage_strategy_1: 4`, consistent with 0100's
 *    decision to use short `StrategyId`s everywhere and avoid suffix-string parsing.
 */

import { z } from 'zod'
import { STRATEGY_IDS, type StrategyId } from './canonical.js'
import { zodErrorToConfigError } from './schema.js'
import { parseYamlMapping } from './yaml.js'

export const EXCHANGE_IDS = ['binance', 'bybit', 'okx', 'bitget', 'gateio', 'kucoin'] as const
export type ExchangeId = (typeof EXCHANGE_IDS)[number]

/** Per-exchange delta shape (`00_globals.md` §6): only these three keys may override. */
export const ExchangeDeltaSchema = z
  .object({
    funding_fee_timeout_seconds: z.int().optional(),
    // Nested, not flat `leverage_strategy_1` — see file header. `partialRecord`
    // because a profile overrides only the strategies it names.
    leverage: z.partialRecord(z.enum([...STRATEGY_IDS]), z.int()).optional(),
    ws_order_rest_fallback: z.boolean().optional(),
  })
  .strict()

/** One venue's static profile. `ws_order_adapter` records capability (08 §6). */
export const ExchangeProfileYamlSchema = z
  .object({
    taker_fee_pct: z.number(),
    maker_fee_pct: z.number(),
    submission_stagger_ms: z.int().gt(0),
    rate_limit_reserve_pct: z.number().gte(0).lte(100),
    ws_order_adapter: z.boolean(),
    ws: z
      .object({
        public_url: z.string().min(1),
        private_url: z.string().min(1),
      })
      .strict(),
    deltas: ExchangeDeltaSchema.default({}),
  })
  .strict()

/** Fixed 6-key container — every venue present, no unknown venues (`.strict()`). */
export const ExchangesYamlSchema = z
  .object(
    Object.fromEntries(EXCHANGE_IDS.map((id) => [id, ExchangeProfileYamlSchema])) as Record<
      ExchangeId,
      typeof ExchangeProfileYamlSchema
    >,
  )
  .strict()

export interface ExchangeDelta {
  readonly fundingFeeTimeoutSeconds?: number
  readonly leverage?: Partial<Record<StrategyId, number>>
  readonly wsOrderRestFallback?: boolean
}

export interface ExchangeProfile {
  readonly takerFeePct: number
  readonly makerFeePct: number
  readonly submissionStaggerMs: number
  readonly rateLimitReservePct: number
  readonly wsOrderAdapter: boolean
  readonly ws: { readonly publicUrl: string; readonly privateUrl: string }
  readonly deltas: ExchangeDelta
}

type ProfileYaml = z.infer<typeof ExchangeProfileYamlSchema>

/** Rekey a validated on-disk profile to its live camelCase shape. */
function toProfile(p: ProfileYaml): ExchangeProfile {
  return {
    takerFeePct: p.taker_fee_pct,
    makerFeePct: p.maker_fee_pct,
    submissionStaggerMs: p.submission_stagger_ms,
    rateLimitReservePct: p.rate_limit_reserve_pct,
    wsOrderAdapter: p.ws_order_adapter,
    ws: { publicUrl: p.ws.public_url, privateUrl: p.ws.private_url },
    deltas: {
      fundingFeeTimeoutSeconds: p.deltas.funding_fee_timeout_seconds,
      leverage: p.deltas.leverage,
      wsOrderRestFallback: p.deltas.ws_order_rest_fallback,
    },
  }
}

/**
 * Parse `exchanges.yaml` text into the frozen per-venue profile map. Pure — the
 * YAML text comes from the caller (`load.ts` reads disk). Throws `ConfigParseError`
 * on any syntax, unknown-key, missing-venue, or bound violation.
 */
export function parseExchangeProfiles(yamlText: string): Readonly<Record<ExchangeId, ExchangeProfile>> {
  const raw = parseYamlMapping(yamlText, 'exchanges config must be a YAML mapping')

  const res = ExchangesYamlSchema.safeParse(raw)
  if (!res.success) throw zodErrorToConfigError(res.error, 'exchanges')

  const out = {} as Record<ExchangeId, ExchangeProfile>
  for (const id of EXCHANGE_IDS) out[id] = toProfile(res.data[id])
  return out
}
