/**
 * The one canonical parameter table — single source of truth (`00_globals.md` §9.2).
 *
 * Every strategy's Zod schema is *derived* from this table ({@link ./schema.ts});
 * hand-writing a per-strategy schema is prohibited (§9.2 item 1). One row per live
 * parameter fixes its name, unit, signedness, bounds, defaults, and the strategies
 * that consume it. Units are load-bearing (`00_globals.md` §1.2) — a value in the
 * wrong unit is a loader error, and this table is where that meaning is pinned.
 *
 * This module is pure data + type declarations. No Zod, no I/O — it is imported by
 * `schema.ts` (which owns the Zod construction) and by tests that assert on the table.
 */

export const STRATEGY_IDS = ['s1', 's1-ws', 's2', 's3a', 's4-1a', 's4-2a', 's6'] as const
export type StrategyId = (typeof STRATEGY_IDS)[number]

/** LONG strategies for the S3a co-run guard (`00_globals.md` §9.1). S6 is exempt. */
export const LONG_STRATEGY_IDS = ['s1', 's1-ws', 's2', 's4-1a', 's4-2a'] as const

/** Which YAML container a parameter lives in (`09_configuration.md` §3). */
export type Container = 'strategy_params' | 'sizing'

/** A single-field numeric bound. `exclusive*` flip `>=`/`<=` to `>`/`<`. */
export interface Bound {
  readonly min?: number
  readonly max?: number
  readonly exclusiveMin?: boolean
  readonly exclusiveMax?: boolean
}

export interface CanonicalParam {
  /** camelCase runtime key, e.g. `negativeFundingThresholdPercent`. */
  readonly liveKey: string
  /** snake_case on-disk key, e.g. `negative_funding_threshold_percent`. */
  readonly yamlKey: string
  /** Which YAML block the key is read from. */
  readonly container: Container
  readonly unit: 'percent' | 'fraction' | 'seconds' | 'multiplier' | 'usd' | 'integer' | 'enum'
  readonly signedness: 'signed-negative' | 'signed-any' | 'absolute' | 'n/a'
  /** Absent for a strategy ⇒ that field is required (no default) for it. */
  readonly schemaDefaults: Partial<Record<StrategyId, number | string>>
  /** Drives the per-strategy whitelist and `.strict()` unknown-key rejection. */
  readonly strategies: readonly StrategyId[]
  /** Uniform bound applied to every strategy using the key. */
  readonly bounds?: Bound
  /** Per-strategy bound override (wins over {@link bounds}). */
  readonly boundsByStrategy?: Partial<Record<StrategyId, Bound>>
  /** Cross-field refinement tag, resolved in `schema.ts`. */
  readonly crossFieldRefinement?: 'ladder-bottom-gt-top' | 'sl-mult-gt-limit-offset-mult'
  /** Marks the take-profit unit guard (`take_profit_pct < 0.05` → `unit_suspect_fraction`). */
  readonly unitGuard?: 'unit_suspect_fraction'
  /** Legacy on-disk alias accepted for one migration cycle, with a warning (§11-R6). */
  readonly legacyAlias?: { readonly yamlKey: string; readonly warning: string }
  readonly zodType: 'number' | 'int' | 'enum'
  readonly enumValues?: readonly string[]
}

const ALL_LONG_AND_SHORT: readonly StrategyId[] = ['s1', 's1-ws', 's2', 's3a', 's4-1a', 's4-2a']
const ALL: readonly StrategyId[] = STRATEGY_IDS

/**
 * The table. One row per live parameter (`00_globals.md` §8.2). Bounds mirror §9.1
 * exactly; defaults mirror the §8.2 "Schema default" column (absent = required).
 */
export const CANONICAL_PARAMS: readonly CanonicalParam[] = [
  {
    liveKey: 'negativeFundingThresholdPercent',
    yamlKey: 'negative_funding_threshold_percent',
    container: 'strategy_params',
    unit: 'percent',
    signedness: 'signed-negative',
    schemaDefaults: { s1: -0.4, 's1-ws': -0.4, s2: -0.4, s3a: -0.4, 's4-1a': -0.4, 's4-2a': -0.4 },
    strategies: ALL_LONG_AND_SHORT,
    bounds: { min: -5.0, max: 0, exclusiveMax: true },
    zodType: 'number',
  },
  {
    liveKey: 'fundingThresholdPercent',
    yamlKey: 'funding_threshold_percent',
    container: 'strategy_params',
    unit: 'percent',
    signedness: 'signed-any',
    schemaDefaults: { s6: 0 },
    strategies: ['s6'],
    bounds: { min: -5.0, max: 5.0 },
    legacyAlias: {
      yamlKey: 'funding_threshold',
      warning:
        "legacy key 'funding_threshold' is deprecated; rename to 'funding_threshold_percent' (00_globals §11-R6)",
    },
    zodType: 'number',
  },
  {
    liveKey: 'entryOffsetSeconds',
    yamlKey: 'entry_offset_seconds',
    container: 'strategy_params',
    unit: 'seconds',
    signedness: 'absolute',
    schemaDefaults: { s1: 5, 's1-ws': 5, s2: 5, s3a: 5, 's4-1a': 5, 's4-2a': 5, s6: 5 },
    strategies: ALL,
    bounds: { min: 2 },
    zodType: 'int',
  },
  {
    liveKey: 'exitOffsetSeconds',
    yamlKey: 'exit_offset_seconds',
    container: 'strategy_params',
    unit: 'seconds',
    signedness: 'absolute',
    schemaDefaults: { s1: 6 },
    strategies: ['s1'],
    bounds: { min: 5, exclusiveMin: true },
    zodType: 'int',
  },
  {
    liveKey: 'fundingFeeTimeoutSeconds',
    yamlKey: 'funding_fee_timeout_seconds',
    container: 'strategy_params',
    unit: 'seconds',
    signedness: 'absolute',
    schemaDefaults: { 's1-ws': 30, s2: 30, s6: 30 },
    strategies: ['s1-ws', 's2', 's6'],
    bounds: { min: 5, max: 120 },
    zodType: 'int',
  },
  {
    liveKey: 'retracementPct',
    yamlKey: 'retracement_pct',
    container: 'strategy_params',
    unit: 'fraction',
    signedness: 'absolute',
    schemaDefaults: { s2: 0.5 },
    strategies: ['s2'],
    bounds: { min: 0, max: 1.0, exclusiveMin: true },
    zodType: 'number',
  },
  {
    liveKey: 'stopLossPercent',
    yamlKey: 'stop_loss_percent',
    container: 'strategy_params',
    unit: 'percent',
    signedness: 'absolute',
    schemaDefaults: { s3a: 1.0 },
    strategies: ['s3a'],
    bounds: { min: 0.2, max: 5.0 },
    zodType: 'number',
  },
  {
    liveKey: 'takeProfitPct',
    yamlKey: 'take_profit_pct',
    container: 'strategy_params',
    unit: 'percent',
    signedness: 'absolute',
    schemaDefaults: { 's4-1a': 0.2, 's4-2a': 0.2 },
    strategies: ['s4-1a', 's4-2a'],
    bounds: { min: 0.05, max: 5.0 },
    unitGuard: 'unit_suspect_fraction',
    zodType: 'number',
  },
  {
    liveKey: 'tpVariantAMultiplier',
    yamlKey: 'tp_variant_a_multiplier',
    container: 'strategy_params',
    unit: 'multiplier',
    signedness: 'absolute',
    schemaDefaults: { s3a: 1.5 },
    strategies: ['s3a'],
    bounds: { min: 0, exclusiveMin: true },
    zodType: 'number',
  },
  {
    liveKey: 'tpMultiplier',
    yamlKey: 'tp_multiplier',
    container: 'strategy_params',
    unit: 'multiplier',
    signedness: 'absolute',
    schemaDefaults: { s6: 0.5 },
    strategies: ['s6'],
    bounds: { min: 0, exclusiveMin: true },
    zodType: 'number',
  },
  {
    liveKey: 'slMultiplier',
    yamlKey: 'sl_multiplier',
    container: 'strategy_params',
    unit: 'multiplier',
    signedness: 'absolute',
    schemaDefaults: { s2: 1.0, 's4-1a': 1.0, 's4-2a': 1.0, s6: 1.0 },
    strategies: ['s2', 's4-1a', 's4-2a', 's6'],
    // Three distinct ranges (§9.1); S4.2a also carries a cross-field refinement.
    boundsByStrategy: {
      s2: { min: 0.5, max: 4.0 },
      's4-1a': { min: 0.5, max: 4.0 },
      's4-2a': { min: 1.0, max: 4.0 },
      s6: { min: 0.5, max: 4.0 },
    },
    crossFieldRefinement: 'sl-mult-gt-limit-offset-mult',
    zodType: 'number',
  },
  {
    liveKey: 'ladderCount',
    yamlKey: 'ladder_count',
    container: 'strategy_params',
    unit: 'integer',
    signedness: 'absolute',
    schemaDefaults: { 's4-1a': 5 },
    strategies: ['s4-1a'],
    bounds: { min: 2, max: 20 },
    zodType: 'int',
  },
  {
    liveKey: 'ladderTopMult',
    yamlKey: 'ladder_top_mult',
    container: 'strategy_params',
    unit: 'multiplier',
    signedness: 'absolute',
    schemaDefaults: { 's4-1a': 0.5 },
    strategies: ['s4-1a'],
    bounds: { min: 0, exclusiveMin: true },
    zodType: 'number',
  },
  {
    liveKey: 'ladderBottomMult',
    yamlKey: 'ladder_bottom_mult',
    container: 'strategy_params',
    unit: 'multiplier',
    signedness: 'absolute',
    schemaDefaults: { 's4-1a': 1.5 },
    strategies: ['s4-1a'],
    bounds: { min: 0, exclusiveMin: true },
    crossFieldRefinement: 'ladder-bottom-gt-top',
    zodType: 'number',
  },
  {
    liveKey: 'limitOffsetMult',
    yamlKey: 'limit_offset_mult',
    container: 'strategy_params',
    unit: 'multiplier',
    signedness: 'absolute',
    schemaDefaults: { 's4-2a': 0.75 },
    strategies: ['s4-2a'],
    bounds: { min: 0, exclusiveMin: true },
    zodType: 'number',
  },
  {
    liveKey: 'deadlineSeconds',
    yamlKey: 'deadline_seconds',
    container: 'strategy_params',
    unit: 'seconds',
    signedness: 'absolute',
    schemaDefaults: {}, // per-strategy proposed value, no uniform schema default
    strategies: ['s2', 's3a', 's4-1a', 's4-2a', 's6'],
    bounds: { min: 10, max: 3600 },
    zodType: 'int',
  },
  {
    liveKey: 'mainSide',
    yamlKey: 'main_side',
    container: 'strategy_params',
    unit: 'enum',
    signedness: 'n/a',
    schemaDefaults: {}, // required
    strategies: ['s6'],
    zodType: 'enum',
    enumValues: ['long', 'short'],
  },
  {
    // Sizing: sub-account notional per intent. Non-S6 strategies (`00_globals.md` §8.2).
    liveKey: 'amountUsd',
    yamlKey: 'amount_usd',
    container: 'sizing',
    unit: 'usd',
    signedness: 'absolute',
    schemaDefaults: { s1: 20, 's1-ws': 20, s2: 20, s3a: 20, 's4-1a': 20, 's4-2a': 20 },
    strategies: ALL_LONG_AND_SHORT,
    bounds: { min: 0, exclusiveMin: true },
    zodType: 'number',
  },
  {
    // Sizing: S6 shares the on-disk key `sizing.amount_usd` but resolves to `mainAmountUsd`.
    liveKey: 'mainAmountUsd',
    yamlKey: 'amount_usd',
    container: 'sizing',
    unit: 'usd',
    signedness: 'absolute',
    schemaDefaults: {}, // S6: required
    strategies: ['s6'],
    bounds: { min: 0, exclusiveMin: true },
    zodType: 'number',
  },
  {
    liveKey: 'leverage',
    yamlKey: 'leverage',
    container: 'sizing',
    unit: 'integer',
    signedness: 'absolute',
    schemaDefaults: { s1: 4, 's1-ws': 4, s2: 4, s3a: 4, 's4-1a': 4, 's4-2a': 4, s6: 4 },
    strategies: ALL,
    bounds: { min: 1 },
    zodType: 'int',
  },
]

/** Resolve the effective bound for a param on a given strategy. */
export function boundFor(param: CanonicalParam, strategyId: StrategyId): Bound | undefined {
  return param.boundsByStrategy?.[strategyId] ?? param.bounds
}

/** Params a strategy consumes in a given container. */
export function paramsFor(strategyId: StrategyId, container: Container): CanonicalParam[] {
  return CANONICAL_PARAMS.filter((p) => p.container === container && p.strategies.includes(strategyId))
}

/** The live (camelCase) key an on-disk key resolves to for a strategy, or undefined. */
export function liveKeyFor(yamlKey: string, strategyId: StrategyId, container: Container): string | undefined {
  return paramsFor(strategyId, container).find((p) => p.yamlKey === yamlKey)?.liveKey
}
