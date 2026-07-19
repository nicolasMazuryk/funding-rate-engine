/** Config module barrel (`09_configuration.md`). */

export { boundViolation } from './bound-check.js'
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
  checkDeadlineVsTimeout,
  checkSizingFeasibilityHint,
  checkWsMandatoryGuard,
  SIZING_FEASIBILITY_MIN_NOTIONAL_USD_HINT,
} from './cross-checks.js'
export { deepFreeze } from './deep-freeze.js'
export { applyExchangeDeltas, type DeltaMergeResult } from './delta-merge.js'
export type { EffectiveConfig } from './effective-config.js'
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
export {
  EXCHANGE_IDS,
  type ExchangeDelta,
  ExchangeDeltaSchema,
  type ExchangeId,
  type ExchangeProfile,
  ExchangeProfileYamlSchema,
  ExchangesYamlSchema,
  parseExchangeProfiles,
} from './exchange-schema.js'
export type { InstrumentValidationHook } from './instrument-validation.js'
export {
  type ConfigSources,
  type LoadOptions,
  loadEffectiveConfig,
  loadEffectiveConfigFromSources,
} from './load.js'
export { type ParsedStrategyConfig, parseStrategyConfig } from './parse-strategy-config.js'
export { PINO_REDACTION_PATHS } from './redaction.js'
export { computeConfigRevisionHash, stableStringify } from './revision-hash.js'
export {
  buildSizingSchema,
  buildStrategyParamsSchema,
  SIZING_SCHEMAS,
  STRATEGY_PARAMS_SCHEMAS,
  StrategyYamlSchema,
  zodErrorToConfigError,
} from './schema.js'
