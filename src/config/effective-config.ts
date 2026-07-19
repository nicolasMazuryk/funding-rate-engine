/**
 * `EffectiveConfig` (`09_configuration.md` §5) — the single immutable, hashed
 * descriptor an instance runs on. Everything (identity + strategy params + venue
 * deltas + cross-checks) is derivable from it; nothing reads config from disk after
 * startup. Built and frozen by `load.ts`.
 */

import type { StrategyId } from './canonical.js'
import type { Exchange, KillSwitchState, ParsedEnv } from './env.js'
import type { ExchangeProfile } from './exchange-schema.js'

export interface EffectiveConfig {
  // identity + wiring (from .env)
  readonly exchange: Exchange
  readonly strategy: StrategyId
  readonly subaccount: string
  readonly databaseUrl: string
  readonly logLevel: ParsedEnv['logLevel']
  readonly killSwitch: KillSwitchState

  // instance behavior (strategy YAML, post delta-merge)
  readonly instance: { readonly exchange: string; readonly strategy: StrategyId; readonly enabled: boolean }
  readonly sizing: Readonly<Record<string, number>>
  readonly strategyParams: Readonly<Record<string, number | string>>
  readonly risk: Readonly<Record<string, number>>
  readonly symbols: { readonly mode: string; readonly deny: readonly string[] }

  // venue profile + resolved WS fallback
  readonly exchangeProfile: ExchangeProfile
  readonly wsOrderRestFallback: boolean

  // secrets (excluded from the revision hash)
  readonly secrets: ParsedEnv['secrets']

  readonly warnings: readonly string[]
  readonly revisionHash: string
}
