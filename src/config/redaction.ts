/**
 * Pino redaction paths for secrets (`09_configuration.md` §2: secrets are never logged —
 * redaction on `*_SECRET`, `*_KEY`, `*_PASSPHRASE`). Consumed by `src/replay/logger.ts`
 * (wired in task 0430; the list had no importer before that).
 *
 * Caveat on the three glob rows: pino's `*` is a **whole-segment** wildcard (`*.apiKey`
 * matches `anything.apiKey`), not a substring one, so `*_PASSPHRASE` does **not** match a
 * top-level `OKX_API_PASSPHRASE` key. The `secrets.*` rows are what actually censor — and
 * they cover the only shape a secret reaches a log line in, since `ParsedEnv.secrets` is the
 * single place credentials live (`09` §2). The globs stay as the declared intent; making them
 * real needs either an explicit per-venue list or a pino `censor` hook — logged in SUGGESTIONS
 * rather than widened here.
 */

export const PINO_REDACTION_PATHS: readonly string[] = [
  'secrets.apiKey',
  'secrets.apiSecret',
  'secrets.apiPassphrase',
  '*_KEY',
  '*_SECRET',
  '*_PASSPHRASE',
]
