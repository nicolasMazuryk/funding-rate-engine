/**
 * Shared YAML-parse prologue for the config parsers (`09_configuration.md` §5).
 * Both `parse-strategy-config.ts` and `exchange-schema.ts` need the same first
 * two steps — parse the text, then reject anything that isn't a mapping — before
 * their Zod schemas run. One definition keeps the error codes/paths identical.
 */

import YAML from 'yaml'
import { ConfigParseError } from './errors.js'

/**
 * Parse `yamlText` and assert it is a YAML mapping. Throws `ConfigParseError`
 * with code `yaml_syntax` on a parse failure and `invalid_type` (path `(root)`,
 * caller-supplied `rootMessage`) on a non-object top level.
 */
export function parseYamlMapping(yamlText: string, rootMessage: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = YAML.parse(yamlText)
  } catch (e) {
    throw new ConfigParseError('(yaml)', `YAML syntax error: ${(e as Error).message}`, 'yaml_syntax')
  }
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigParseError('(root)', rootMessage, 'invalid_type')
  }
  return raw as Record<string, unknown>
}
