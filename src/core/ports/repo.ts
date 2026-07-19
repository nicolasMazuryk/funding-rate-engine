/**
 * `Repo` port (`08_system_overview.md` §5; sketched by `14_persistence_and_recovery.md` §7).
 *
 * The core reads/writes through this repository interface, never Drizzle or `pg`
 * directly — that keeps the runtime pure and lets tests substitute an in-memory
 * repo (`17`). Appending a transition is the `TransitionLog` port's job (task
 * 0070, tier 1 local WAL); `Repo` covers what only the centralized store answers:
 * loading non-terminal intents for crash recovery.
 *
 * PLACEHOLDER: `IntentId` / `IntentState` / `IntentSnapshot` are deliberately loose
 * here. The intent FSM (task 0040) owns the canonical intent state type and will
 * sharpen these; downstream tasks (0080 Postgres, 0370 recovery) grow the surface.
 */

/** Intent identifier. Placeholder — narrowed by the intent FSM (0040). */
export type IntentId = string

/** Intent FSM state. Placeholder string; the closed union lands with the FSM (0040). */
export type IntentState = string

/** A recovered non-terminal intent (minimal; sharpened by 0040/0370). */
export interface IntentSnapshot {
  readonly intentId: IntentId
  readonly state: IntentState
  readonly symbol: string
}

export interface Repo {
  /** Load intents not in a terminal state, for crash recovery (`14` §7). */
  loadNonTerminalIntents(): Promise<readonly IntentSnapshot[]>
}
