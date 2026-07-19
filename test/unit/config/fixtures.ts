import YAML from 'yaml'
import type { StrategyId } from '../../../src/config/canonical.js'

/** Valid proposed `strategy_params` per strategy (matches config/*.yaml). */
export const VALID_PARAMS: Record<StrategyId, Record<string, number | string>> = {
  s1: { negative_funding_threshold_percent: -0.4, entry_offset_seconds: 3, exit_offset_seconds: 6 },
  's1-ws': { negative_funding_threshold_percent: -0.4, entry_offset_seconds: 3, funding_fee_timeout_seconds: 10 },
  s2: {
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 3,
    retracement_pct: 1.0,
    sl_multiplier: 2.0,
    deadline_seconds: 900,
    funding_fee_timeout_seconds: 30,
  },
  s3a: {
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 3,
    stop_loss_percent: 1.0,
    tp_variant_a_multiplier: 1.5,
    deadline_seconds: 900,
  },
  's4-1a': {
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 3,
    ladder_count: 5,
    ladder_top_mult: 0.7,
    ladder_bottom_mult: 1.8,
    take_profit_pct: 0.3,
    sl_multiplier: 2.5,
    deadline_seconds: 1800,
  },
  's4-2a': {
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 5,
    limit_offset_mult: 0.75,
    take_profit_pct: 0.2,
    sl_multiplier: 1.5,
    deadline_seconds: 60,
  },
  s6: {
    main_side: 'long',
    funding_threshold_percent: 0.1,
    entry_offset_seconds: 3,
    funding_fee_timeout_seconds: 10,
    tp_multiplier: 1.5,
    sl_multiplier: 1.5,
    deadline_seconds: 1800,
  },
}

export const VALID_SIZING: Record<StrategyId, Record<string, number>> = {
  s1: { amount_usd: 10, leverage: 5 },
  's1-ws': { amount_usd: 10, leverage: 5 },
  s2: { amount_usd: 10, leverage: 5 },
  s3a: { amount_usd: 10, leverage: 5 },
  's4-1a': { amount_usd: 10, leverage: 5 },
  's4-2a': { amount_usd: 20, leverage: 4 },
  s6: { amount_usd: 10, leverage: 5 },
}

/** Serialize a full instance config to YAML text, overriding params/sizing as needed. */
export function strategyYaml(opts: {
  strategy: StrategyId
  enabled?: boolean
  params?: Record<string, number | string>
  sizing?: Record<string, number>
}): string {
  const { strategy, enabled = true } = opts
  return YAML.stringify({
    instance: { exchange: 'binance', strategy, enabled },
    sizing: opts.sizing ?? VALID_SIZING[strategy],
    strategy_params: opts.params ?? VALID_PARAMS[strategy],
    risk: { max_concurrent_intents: 1, max_notional_usd: 20, max_daily_loss_usd: 100, breaker_error_threshold: 5 },
    symbols: { mode: 'auto', deny: [] },
  })
}
