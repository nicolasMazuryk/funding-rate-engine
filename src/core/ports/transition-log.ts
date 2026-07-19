/**
 * `TransitionLog` port (`14_persistence_and_recovery.md` §2, §2.1).
 *
 * The local, on-box, fsync'd append-only WAL that gates every side effect —
 * tier 1 of the two-tier write path (§2.1). An intent-machine transition
 * observer (`08` §5, `12` §5) calls `append` synchronously before the caller
 * proceeds to the side effect it authorizes (order submit/cancel/flatten).
 * The concrete file-backed implementation lands in `src/persistence/wal/`
 * (task 0070); the Postgres forwarder (tier 2) is task 0080.
 */

/** One durable transition record, appended before its side effect (`14` §2.1). */
export interface TransitionLogEntry {
  /** Transition time, epoch ms UTC. */
  readonly ts: number
  readonly intentId: string
  readonly fromState: string
  readonly toState: string
  /** The transition's payload, opaque to the log (e.g. `IntentTerminalPayload`). */
  readonly payload: unknown
  /** Present when the transition authorizes an order submission (`11` §4). */
  readonly clientOrderId?: string
}

export interface TransitionLog {
  /** Durably append `entry`; resolves only after the record is fsync'd (`14` §2.1 step 1). */
  append(entry: TransitionLogEntry): Promise<void>
}
