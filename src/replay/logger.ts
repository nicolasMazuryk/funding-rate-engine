/**
 * Thin pino wrapper for operational logging (task 0090). Pino is added here for
 * human-facing diagnostics only — it is NOT the byte-compared golden artifact
 * (its default envelope carries `pid`/`hostname`/`time`, which would break
 * determinism). The compared streams are the WAL and the events log (decision
 * #3). Moved to `src/replay/` in task 0170 with the skeleton composition root
 * (which uses it) so non-test callers need not import test code; `main.ts` gets
 * the real composition in a later task.
 *
 * Defaults to `silent` so the unit suite stays quiet; override with `LOG_LEVEL`.
 *
 * Secret redaction (`09` §2) is wired here (task 0430): `PINO_REDACTION_PATHS` has declared
 * the `*_KEY` / `*_SECRET` / `*_PASSPHRASE` paths since task 0100 but had **no importer**, so
 * a secret reaching a log line would have been printed verbatim. OKX is the first venue to
 * carry a third credential, which is what made an unwired redaction list worth closing.
 */

import pino, { type Logger } from 'pino'
import { PINO_REDACTION_PATHS } from '../config/redaction.js'

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'silent',
    base: bindings,
    redact: { paths: [...PINO_REDACTION_PATHS], censor: '[redacted]' },
  })
}
