/**
 * Pure entry point: strategy YAML text → validated, camelCase-keyed config object.
 *
 * String in, object out — no `fs` reads (disk loading is task 0110's pipeline job;
 * `09_configuration.md` §5). The one place raw `ZodError`s are caught and turned
 * into `ConfigParseError`s, and where on-disk snake_case keys become live camelCase
 * keys. Fail loud, fail early: the first invalid field aborts with the exact path.
 */

import YAML from 'yaml'
import { type Container, liveKeyFor, paramsFor, type StrategyId } from './canonical.js'
import { deepFreeze } from './deep-freeze.js'
import { ConfigParseError } from './errors.js'
import { SIZING_SCHEMAS, STRATEGY_PARAMS_SCHEMAS, StrategyYamlSchema, zodErrorToConfigError } from './schema.js'

export interface ParsedStrategyConfig {
  readonly instance: { readonly exchange: string; readonly strategy: StrategyId; readonly enabled: boolean }
  readonly sizing: Readonly<Record<string, number>>
  readonly strategyParams: Readonly<Record<string, number | string>>
  readonly risk: Readonly<Record<string, number>>
  readonly symbols: { readonly mode: string; readonly deny: readonly string[] }
  readonly warnings: readonly string[]
}

/** Copy any legacy on-disk alias to its canonical key, warn, and drop the alias. */
function preprocessLegacyAliases(rawParams: unknown, strategyId: StrategyId, warnings: string[]): unknown {
  if (rawParams === null || typeof rawParams !== 'object') return rawParams // let the schema reject non-objects
  const obj = { ...(rawParams as Record<string, unknown>) }
  for (const row of paramsFor(strategyId, 'strategy_params')) {
    const alias = row.legacyAlias
    if (alias === undefined || !(alias.yamlKey in obj)) continue
    if (!(row.yamlKey in obj)) obj[row.yamlKey] = obj[alias.yamlKey]
    delete obj[alias.yamlKey]
    warnings.push(alias.warning)
  }
  return obj
}

/** Rekey a validated on-disk object to its live camelCase keys. */
function mapLive(data: unknown, strategyId: StrategyId, container: Container): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const [yamlKey, value] of Object.entries(data as Record<string, unknown>)) {
    const live = liveKeyFor(yamlKey, strategyId, container)
    if (live !== undefined) out[live] = value as number | string
  }
  return out
}

export function parseStrategyConfig(yamlText: string, strategyId: StrategyId): ParsedStrategyConfig {
  let raw: unknown
  try {
    raw = YAML.parse(yamlText)
  } catch (e) {
    throw new ConfigParseError('(yaml)', `YAML syntax error: ${(e as Error).message}`, 'yaml_syntax')
  }
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigParseError('(root)', 'config must be a YAML mapping', 'invalid_type')
  }

  const container = StrategyYamlSchema.safeParse(raw)
  if (!container.success) throw zodErrorToConfigError(container.error)
  const c = container.data

  if (c.instance.strategy !== strategyId) {
    throw new ConfigParseError(
      'instance.strategy',
      `expected '${strategyId}', got '${c.instance.strategy}'`,
      'strategy_mismatch',
    )
  }

  const warnings: string[] = []
  const rawParams = preprocessLegacyAliases(c.strategy_params, strategyId, warnings)

  const spRes = STRATEGY_PARAMS_SCHEMAS[strategyId].safeParse(rawParams)
  if (!spRes.success) throw zodErrorToConfigError(spRes.error, 'strategy_params')

  const szRes = SIZING_SCHEMAS[strategyId].safeParse(c.sizing)
  if (!szRes.success) throw zodErrorToConfigError(szRes.error, 'sizing')

  return deepFreeze({
    instance: { exchange: c.instance.exchange, strategy: strategyId, enabled: c.instance.enabled },
    sizing: mapLive(szRes.data, strategyId, 'sizing') as Record<string, number>,
    strategyParams: mapLive(spRes.data, strategyId, 'strategy_params'),
    risk: c.risk as Record<string, number>,
    symbols: { mode: c.symbols.mode, deny: c.symbols.deny },
    warnings,
  })
}
