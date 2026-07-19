/**
 * Thin pino wrapper for operational logging (task 0090). Pino is added here for
 * human-facing diagnostics only — it is NOT the byte-compared golden artifact
 * (its default envelope carries `pid`/`hostname`/`time`, which would break
 * determinism). The compared streams are the WAL and the events log (decision
 * #3). Lives under `test/helpers/` because there is no production entry point
 * yet; `main.ts` gets the real composition in a later task.
 *
 * Defaults to `silent` so the unit suite stays quiet; override with `LOG_LEVEL`.
 */

import pino, { type Logger } from 'pino'

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return pino({ level: process.env.LOG_LEVEL ?? 'silent', base: bindings })
}
