/**
 * Zod schemas derived FROM the canonical table ({@link ./canonical.ts}). This is
 * the *only* place Zod is constructed for strategy parameters — no per-strategy
 * schema is hand-written (`00_globals.md` §9.2 item 1). Bounds, defaults, unit
 * guards, and cross-field refinements are all read off the table row, so adding a
 * parameter is a one-row edit in `canonical.ts`, never a schema edit here.
 */

import { z } from 'zod'
import { type Bound, boundFor, type CanonicalParam, paramsFor, STRATEGY_IDS, type StrategyId } from './canonical.js'
import { ConfigParseError } from './errors.js'

/** Apply a numeric bound to a number/int schema. `exclusive*` pick `>`/`<`. */
function applyBounds(base: z.ZodNumber, bound: Bound | undefined): z.ZodNumber {
  if (!bound) return base
  let s = base
  if (bound.min !== undefined) s = bound.exclusiveMin ? s.gt(bound.min) : s.gte(bound.min)
  if (bound.max !== undefined) s = bound.exclusiveMax ? s.lt(bound.max) : s.lte(bound.max)
  return s
}

/**
 * Build the Zod field for one canonical row on one strategy: base type + bounds +
 * unit guard + default. The take-profit unit guard replaces the lower bound with a
 * coded `unit_suspect_fraction` issue (§9.2 item 3) so tests can assert on the code.
 */
function buildField(param: CanonicalParam, strategyId: StrategyId): z.ZodTypeAny {
  const bound = boundFor(param, strategyId)
  let field: z.ZodTypeAny

  if (param.zodType === 'enum') {
    field = z.enum([...(param.enumValues ?? [])])
  } else if (param.unitGuard) {
    const min = bound?.min ?? 0.05
    let s = z.number()
    if (bound?.max !== undefined) s = s.lte(bound.max)
    field = s.superRefine((v, ctx) => {
      if (v < min) {
        ctx.addIssue({
          code: 'custom',
          message: `value ${v} looks like a fraction; percent expected (>= ${min})`,
          params: { code: param.unitGuard },
        })
      }
    })
  } else {
    const base = param.zodType === 'int' ? z.int() : z.number()
    field = applyBounds(base, bound)
  }

  const dflt = param.schemaDefaults[strategyId]
  if (dflt !== undefined) field = field.default(dflt)
  return field
}

/** Static cross-field refinement definitions, keyed by the table's tag. */
const CROSS_FIELD: Record<
  NonNullable<CanonicalParam['crossFieldRefinement']>,
  {
    readonly requires: readonly string[]
    readonly check: (o: Record<string, unknown>) => boolean
    readonly path: readonly string[]
    readonly code: string
    readonly message: string
  }
> = {
  'ladder-bottom-gt-top': {
    requires: ['ladder_bottom_mult', 'ladder_top_mult'],
    check: (o) => Number(o.ladder_bottom_mult) > Number(o.ladder_top_mult),
    path: ['ladder_bottom_mult'],
    code: 'ladder_inverted',
    message: 'ladder_bottom_mult must be > ladder_top_mult (else ladder inverted, 00_globals §9.1)',
  },
  'sl-mult-gt-limit-offset-mult': {
    requires: ['sl_multiplier', 'limit_offset_mult'],
    check: (o) => Number(o.sl_multiplier) > Number(o.limit_offset_mult),
    path: ['sl_multiplier'],
    code: 'sl_below_entry',
    message: 'sl_multiplier must be > limit_offset_mult (else stop sits above entry limit, 00_globals §9.1)',
  },
}

/** Chain the cross-field refinements whose required keys are all present. */
function applyCrossFields(schema: z.ZodTypeAny, rows: readonly CanonicalParam[]): z.ZodTypeAny {
  const yamlKeys = new Set(rows.map((r) => r.yamlKey))
  const tags = new Set(
    rows.map((r) => r.crossFieldRefinement).filter((t): t is NonNullable<typeof t> => t !== undefined),
  )
  let out = schema
  for (const tag of tags) {
    const def = CROSS_FIELD[tag]
    if (!def.requires.every((k) => yamlKeys.has(k))) continue
    out = out.superRefine((o, ctx) => {
      if (!def.check(o as Record<string, unknown>)) {
        ctx.addIssue({ code: 'custom', message: def.message, path: [...def.path], params: { code: def.code } })
      }
    })
  }
  return out
}

/** Build the `strategy_params` schema for a strategy from its canonical rows. */
export function buildStrategyParamsSchema(strategyId: StrategyId): z.ZodTypeAny {
  const rows = paramsFor(strategyId, 'strategy_params')
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const row of rows) shape[row.yamlKey] = buildField(row, strategyId)
  return applyCrossFields(z.object(shape).strict(), rows)
}

/** Build the `sizing` schema for a strategy (uniform `amount_usd` + `leverage`). */
export function buildSizingSchema(strategyId: StrategyId): z.ZodTypeAny {
  const rows = paramsFor(strategyId, 'sizing')
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const row of rows) shape[row.yamlKey] = buildField(row, strategyId)
  return z.object(shape).strict()
}

/** Per-strategy schemas, built once from the table. */
export const STRATEGY_PARAMS_SCHEMAS: Record<StrategyId, z.ZodTypeAny> = Object.fromEntries(
  STRATEGY_IDS.map((id) => [id, buildStrategyParamsSchema(id)]),
) as Record<StrategyId, z.ZodTypeAny>

export const SIZING_SCHEMAS: Record<StrategyId, z.ZodTypeAny> = Object.fromEntries(
  STRATEGY_IDS.map((id) => [id, buildSizingSchema(id)]),
) as Record<StrategyId, z.ZodTypeAny>

/**
 * Fixed container shape (`09_configuration.md` §3). `sizing` and `strategy_params`
 * are `z.unknown()` here — they are validated per-strategy in
 * `parse-strategy-config.ts`, where the strategy id (hence the row set) is known.
 */
export const StrategyYamlSchema = z
  .object({
    instance: z
      .object({
        exchange: z.string().min(1),
        strategy: z.enum([...STRATEGY_IDS]),
        enabled: z.boolean(),
      })
      .strict(),
    sizing: z.unknown(),
    strategy_params: z.unknown(),
    risk: z
      .object({
        max_concurrent_intents: z.int().gt(0),
        max_notional_usd: z.number().gt(0),
        max_daily_loss_usd: z.number().gt(0),
        breaker_error_threshold: z.int().gte(0),
      })
      .strict(),
    symbols: z
      .object({
        mode: z.enum(['auto', 'manual']),
        deny: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict()

/**
 * Translate the first issue of a `ZodError` into a `ConfigParseError`, so no raw
 * `ZodError` leaves `src/config` (`09_configuration.md` §5). Coded issues (unit
 * guard, cross-field) surface their `params.code`; unknown keys surface
 * `unrecognized_keys`.
 */
export function zodErrorToConfigError(err: z.ZodError, prefix = ''): ConfigParseError {
  const issue = err.issues[0]
  if (issue === undefined) return new ConfigParseError(prefix || '(root)', 'invalid config')

  const segs = [prefix, ...issue.path.map(String)].filter((s) => s.length > 0)
  let path = segs.join('.')
  let reason = issue.message
  let code: string | undefined

  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as { keys?: string[] }).keys ?? []
    path = [prefix, ...keys].filter((s) => s.length > 0).join('.') || path
    reason = `unknown key(s): ${keys.join(', ')}`
    code = 'unrecognized_keys'
  } else if (issue.code === 'custom') {
    code = (issue as { params?: { code?: string } }).params?.code
  } else {
    code = issue.code
  }

  return new ConfigParseError(path || '(root)', reason, code)
}
