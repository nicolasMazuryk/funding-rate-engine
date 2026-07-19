/**
 * Pino redaction paths for secrets (`09_configuration.md` §2: secrets are never
 * logged — redaction on `*_SECRET`, `*_KEY`, `*_PASSPHRASE`). Declared here only;
 * no logger exists yet to wire it to (the logger lands with the composition root).
 */

export const PINO_REDACTION_PATHS: readonly string[] = [
  'secrets.apiKey',
  'secrets.apiSecret',
  'secrets.apiPassphrase',
  '*_KEY',
  '*_SECRET',
  '*_PASSPHRASE',
]
