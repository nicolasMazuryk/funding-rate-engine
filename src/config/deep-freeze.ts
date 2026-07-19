/**
 * Recursive `Object.freeze` for config objects. Extracted from
 * `parse-strategy-config.ts` so both the strategy parser and the effective-config
 * builder share one implementation (`09_configuration.md` §5: `EffectiveConfig` is
 * immutable). Freezing is deep so nested `sizing`/`strategyParams`/`ws` blocks
 * cannot be mutated after startup.
 */

export function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}
