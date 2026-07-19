/** Config module barrel (`09_configuration.md`). */

export {
  type Bound,
  boundFor,
  CANONICAL_PARAMS,
  type CanonicalParam,
  type Container,
  LONG_STRATEGY_IDS,
  liveKeyFor,
  paramsFor,
  STRATEGY_IDS,
  type StrategyId,
} from './canonical.js'
export { type CoRunDescriptor, checkCoRunGuard } from './co-run-guard.js'
export {
  EnvSchema,
  EXCHANGES,
  type Exchange,
  KILL_SWITCH_STATES,
  type KillSwitchState,
  type ParsedEnv,
  parseEnv,
} from './env.js'
export { ConfigParseError } from './errors.js'
export { type ParsedStrategyConfig, parseStrategyConfig } from './parse-strategy-config.js'
export {
  buildSizingSchema,
  buildStrategyParamsSchema,
  SIZING_SCHEMAS,
  STRATEGY_PARAMS_SCHEMAS,
  StrategyYamlSchema,
  zodErrorToConfigError,
} from './schema.js'
