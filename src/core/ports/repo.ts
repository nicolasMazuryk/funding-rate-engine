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

/**
 * A recovered/persisted intent snapshot (minimal; sharpened by 0040/0370).
 *
 * Required fields (`intentId`, `state`, `symbol`) are the 0040/0070 surface and
 * stay stable. The optional fields are what the Postgres tier (0080) persists
 * to the `intents` row; each is absent until its upstream producer exists
 * (`tSettleMs` scheduler, `configHash` config 0100, `exitReason`/`errorCode`
 * only on terminal transitions). Downstream tasks (0090, 0370) should treat
 * this as the current surface, not the final one.
 */
export interface IntentSnapshot {
  readonly intentId: IntentId
  readonly state: IntentState
  readonly symbol: string
  /** Settlement time, epoch ms UTC (`00_globals` §1.2). */
  readonly tSettleMs?: number
  /** `00_globals` §10.1, present only for a `CLOSED` intent. */
  readonly exitReason?: string
  /** `00_globals` §10.2, present only for a terminal-error intent. */
  readonly errorCode?: string
  /** `09` §7 config revision hash. */
  readonly configHash?: string
}

export interface Repo {
  /** Upsert an intent's current state + fields, scoped to the instance (`14` §3). */
  upsertIntentState(snapshot: IntentSnapshot): Promise<void>
  /** Load intents not in a terminal state, for crash recovery (`14` §7). */
  loadNonTerminalIntents(): Promise<readonly IntentSnapshot[]>
}
