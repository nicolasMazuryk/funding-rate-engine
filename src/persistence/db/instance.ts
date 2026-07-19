/**
 * Instance identity triple (`14` §3) — every persisted row is scoped by it.
 *
 * Hardcoded dev default until the config system (0110) supplies the real
 * `exchange`/`strategy`/`subaccount`. Callers (`repo.ts`, `forwarder.ts`) take
 * an `Instance` explicitly; this is only the placeholder value wired in until
 * config lands.
 */
export interface Instance {
  readonly exchange: string
  readonly strategy: string
  readonly subaccount: string
}

/** Dev placeholder instance triple — replace with config-driven value in 0110. */
export const DEV_INSTANCE: Instance = {
  exchange: 'sim',
  strategy: 's1',
  subaccount: 'dev',
}
