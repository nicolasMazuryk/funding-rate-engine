/**
 * `Repo` port (`08_system_overview.md` §5; sketched by `14_persistence_and_recovery.md` §7).
 *
 * The core reads/writes through this repository interface, never Drizzle or `pg`
 * directly — that keeps the runtime pure and lets tests substitute an in-memory
 * repo (`17`). This is the **minimal** surface the walking skeleton needs: append
 * an intent transition, and load non-terminal intents for crash recovery.
 *
 * PLACEHOLDER: `IntentId` / `IntentState` / `IntentSnapshot` are deliberately loose
 * here. The intent FSM (task 0040) owns the canonical intent state type and will
 * sharpen these; downstream tasks (0080 Postgres, 0370 recovery) grow the surface.
 */

/** Intent identifier. Placeholder — narrowed by the intent FSM (0040). */
export type IntentId = string

/** Intent FSM state. Placeholder string; the closed union lands with the FSM (0040). */
export type IntentState = string

/** One durable intent state transition, appended before its side effect (`14` §2.1). */
export interface IntentTransition {
  readonly intentId: IntentId
  readonly from: IntentState
  readonly to: IntentState
  /** Transition time, epoch ms UTC. */
  readonly ts: number
}

/** A recovered non-terminal intent (minimal; sharpened by 0040/0370). */
export interface IntentSnapshot {
  readonly intentId: IntentId
  readonly state: IntentState
  readonly symbol: string
}

export interface Repo {
  /** Durably append a transition (WAL-before-side-effect, `08` §8 / `14` §2.1). */
  appendIntentTransition(transition: IntentTransition): Promise<void>
  /** Load intents not in a terminal state, for crash recovery (`14` §7). */
  loadNonTerminalIntents(): Promise<readonly IntentSnapshot[]>
}
