/**
 * The fail-loud loading pipeline (`09_configuration.md` §5). `loadEffectiveConfigFromSources`
 * is pure (strings in, frozen `EffectiveConfig` out) and unit-testable with no fs or
 * `process.env`; `loadEffectiveConfig` is a thin disk wrapper around it.
 *
 * Steps 1–5 are implemented here; step 6 (instrument validation) needs a live client
 * and lands with the adapter (0190) — see `instrument-validation.ts`. No `process.exit`:
 * there is no composition root yet, so every failure surfaces as a typed
 * `ConfigParseError` for the (future) CLI boundary to turn into an exit code.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import { checkCoRunGuard } from './co-run-guard.js'
import { checkDeadlineVsTimeout, checkSizingFeasibilityHint, checkWsMandatoryGuard } from './cross-checks.js'
import { deepFreeze } from './deep-freeze.js'
import { applyExchangeDeltas } from './delta-merge.js'
import type { EffectiveConfig } from './effective-config.js'
import { parseEnv } from './env.js'
import { ConfigParseError } from './errors.js'
import { type ExchangeId, parseExchangeProfiles } from './exchange-schema.js'
import { parseStrategyConfig } from './parse-strategy-config.js'
import { computeConfigRevisionHash } from './revision-hash.js'

export interface ConfigSources {
  readonly envRecord: Record<string, string | undefined>
  readonly strategyYamlText: string
  readonly exchangesYamlText: string
}

export function loadEffectiveConfigFromSources(sources: ConfigSources): EffectiveConfig {
  // 1. identity + secrets
  const env = parseEnv(sources.envRecord)

  // 2. strategy YAML, with an exchange cross-check against .env identity
  const parsed = parseStrategyConfig(sources.strategyYamlText, env.strategy)
  if (parsed.instance.exchange !== env.exchange) {
    throw new ConfigParseError(
      'instance.exchange',
      `strategy YAML exchange '${parsed.instance.exchange}' != .env EXCHANGE '${env.exchange}'`,
      'exchange_mismatch',
    )
  }

  // 3. exchange profiles + this instance's profile
  const profiles = parseExchangeProfiles(sources.exchangesYamlText)
  const profile = profiles[env.exchange as ExchangeId]
  if (profile === undefined) {
    throw new ConfigParseError('exchanges', `no profile for exchange '${env.exchange}'`, 'missing_exchange_profile')
  }

  // 4. per-exchange deltas, re-validated against canonical bounds
  const merged = applyExchangeDeltas(parsed, profile, env.strategy)

  // 5. cross-checks
  checkCoRunGuard([{ strategyId: env.strategy, enabled: parsed.instance.enabled }])
  checkWsMandatoryGuard(env.strategy, profile, merged.wsOrderRestFallback)
  checkDeadlineVsTimeout(merged.strategyParams, env.strategy)

  const warnings = [...parsed.warnings, ...merged.warnings]
  const sizingHint = checkSizingFeasibilityHint(merged.sizing, env.strategy)
  if (sizingHint !== undefined) warnings.push(sizingHint)

  // hash over the secret-free config, then freeze
  const withoutSecrets = {
    exchange: env.exchange,
    strategy: env.strategy,
    subaccount: env.subaccount,
    databaseUrl: env.databaseUrl,
    logLevel: env.logLevel,
    killSwitch: env.killSwitch,
    instance: parsed.instance,
    sizing: merged.sizing,
    strategyParams: merged.strategyParams,
    risk: parsed.risk,
    symbols: parsed.symbols,
    exchangeProfile: profile,
    wsOrderRestFallback: merged.wsOrderRestFallback,
    warnings,
  }
  const revisionHash = computeConfigRevisionHash(withoutSecrets)

  return deepFreeze({ ...withoutSecrets, secrets: env.secrets, revisionHash })
}

export interface LoadOptions {
  readonly configDir?: string
  readonly envPath?: string
}

/**
 * Disk wrapper: reads `.env` + `config/<STRATEGY>-<EXCHANGE>.yaml` + `config/exchanges.yaml`
 * without mutating global `process.env` (`dotenv.parse` on the file bytes). Unused by
 * anything yet — no `main.ts` exists — but the seam the composition root will call.
 */
export function loadEffectiveConfig(options: LoadOptions = {}): EffectiveConfig {
  const configDir = options.configDir ?? resolve(process.cwd(), 'config')
  const envPath = options.envPath ?? resolve(process.cwd(), '.env')

  const fileEnv = dotenv.parse(readFileSync(envPath))
  const envRecord: Record<string, string | undefined> = { ...process.env, ...fileEnv }

  const env = parseEnv(envRecord)
  const strategyFile = resolve(configDir, `${env.strategy}-${env.exchange}.yaml`)
  const strategyYamlText = readFileSync(strategyFile, 'utf8')
  const exchangesYamlText = readFileSync(resolve(configDir, 'exchanges.yaml'), 'utf8')

  return loadEffectiveConfigFromSources({ envRecord, strategyYamlText, exchangesYamlText })
}
