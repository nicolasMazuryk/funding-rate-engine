/**
 * Config parse errors. Matches the typed-error dialect of
 * `src/core/intent/fsm-engine.ts` (`IllegalTransitionError`): a named `Error`
 * subclass carrying the diagnostic fields as readonly members.
 *
 * No raw `ZodError` escapes `src/config` — every issue is translated into a
 * `ConfigParseError` at the parse boundary (`09_configuration.md` §5: fail loud,
 * log the exact key + reason).
 */

export class ConfigParseError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly code?: string,
  ) {
    super(`[config] ${path}: ${reason}`)
    this.name = 'ConfigParseError'
  }
}
