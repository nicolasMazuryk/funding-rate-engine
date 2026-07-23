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

/** Order status + fill-progress update (bus `OrderUpdate`; natural key `clientOrderId`). */
export interface OrderStatusUpdate {
  readonly clientOrderId: string
  readonly status: string
  readonly filledQty?: number
  readonly venueOrderId?: string
}

/** One append-once fill (natural key `(clientOrderId, ts, qty)`; `14` §3). */
export interface FillRecord {
  readonly clientOrderId: string
  /** Fill price, quote currency. */
  readonly px: number
  /** Fill quantity, base units. */
  readonly qty: number
  /** Fill time, epoch ms UTC. */
  readonly ts: number
  readonly feeClass?: string
}

/** Full order descriptor (live order-manager `req`; enriches the `orders` row). */
export interface OrderDescriptor {
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: string
  readonly type: string
  readonly qty: number
  readonly price?: number
  readonly reduceOnly?: boolean
  readonly venueOrderId?: string
  readonly status?: string
}

/** Current position (bus `PositionUpdate`; natural key `symbol`). */
export interface PositionRecord {
  readonly symbol: string
  readonly side: string
  readonly qty: number
  readonly entryPrice?: number
  /** Last update time, epoch ms UTC. */
  readonly updatedTs: number
}

/** Funding fee (bus `FundingFeeAccrued`; append-once key `(symbol, fundingTime)`). */
export interface FundingEventRecord {
  readonly symbol: string
  /** `T_drop`, epoch ms UTC. */
  readonly fundingTime: number
  /** Funding amount, quote currency; signed. */
  readonly amount: number
  /** Settled funding rate, signed percent. */
  readonly rate?: number
}

/** Current kill-switch state (one row per instance; `13` §2). */
export interface KillSwitchRecord {
  readonly state: string
  readonly reason?: string
  /** Transition time, epoch ms UTC. */
  readonly updatedTs: number
}

/** S2 tracker snapshot (storage only; write wiring is 0370). Natural key `intentId`. */
export interface TrackerSnapshotRecord {
  readonly intentId: string
  /** Serialized `RetracementSnapshot`. */
  readonly snapshot: unknown
  /** Last update time, epoch ms UTC. */
  readonly updatedTs: number
}

export interface Repo {
  /** Upsert an intent's current state + fields, scoped to the instance (`14` §3). */
  upsertIntentState(snapshot: IntentSnapshot): Promise<void>
  /** Load intents not in a terminal state, for crash recovery (`14` §7). */
  loadNonTerminalIntents(): Promise<readonly IntentSnapshot[]>

  // ── Full-schema idempotent writers (`14` §3–§4). Optional: only the Postgres
  // repo implements them; the in-memory repo (engine/tests) omits them, so the
  // projector's `repo.xxx?.()` calls are no-ops there. Each is instance-scoped
  // and idempotent on its natural key (upsert / append-once). ────────────────
  /** Upsert an order's status + fill progress by `clientOrderId`. */
  upsertOrderStatus?(update: OrderStatusUpdate): Promise<void>
  /** Append one fill; a duplicate on `(clientOrderId, ts, qty)` is a no-op. */
  insertFill?(fill: FillRecord): Promise<void>
  /** Upsert the full order descriptor (live path; enriches the nullable cols). */
  upsertOrder?(order: OrderDescriptor): Promise<void>
  /** Upsert the current position by `symbol`. */
  upsertPosition?(position: PositionRecord): Promise<void>
  /** Append one funding event; duplicate `(symbol, fundingTime)` is a no-op. */
  upsertFundingEvent?(event: FundingEventRecord): Promise<void>
  /** Upsert the instance's single kill-switch row. */
  upsertKillSwitch?(record: KillSwitchRecord): Promise<void>
  /** Upsert an S2 tracker snapshot by `intentId`. */
  upsertTrackerSnapshot?(snapshot: TrackerSnapshotRecord): Promise<void>
  /** Load all tracker snapshots for the instance (consumed by 0370 respawn). */
  loadTrackerSnapshots?(): Promise<readonly TrackerSnapshotRecord[]>
}
