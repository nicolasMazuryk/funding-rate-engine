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

/** A time range for a bounded funding-event read, epoch ms UTC (inclusive). */
export interface FundingEventRange {
  readonly fromMs: number
  readonly toMs: number
}

/**
 * One `pnl` row's value set (`00_globals` §8.3; task 0390). Value columns are
 * **quote currency** (deliberate §8.3 deviation, user decision — see
 * `core/accounting/trade-record.ts`). The instance triple is added by the repo.
 * Natural key: `intentId`. Structurally matches `PnlRecord` from the assembler.
 */
export interface PnlRecordRow {
  readonly intentId: string
  readonly pEntry?: number
  readonly pExit?: number
  readonly pAvg?: number
  readonly deltaPnl: number
  readonly fundingPnl: number
  readonly feeCost: number
  readonly netPnl: number
  readonly exitReason?: string
  readonly errorCode?: string
  readonly holdDurationS?: number
  readonly fillCount: number
  readonly fundingReceived: boolean
  readonly tDropOffsetS?: number
}

/**
 * One reconciliation diff row (`15` §2, task 0400). The reconciler writes one per
 * dimension where the engine's persisted record diverged from venue ground truth.
 * Surrogate-id keyed (an intent/symbol reconciles many times); the instance triple
 * is added by the repo. `engineValue`/`venueValue` are the compared scalars in each
 * dimension's natural unit (fills → fee/price/qty; funding → quote amount; position →
 * base-unit qty).
 */
export interface ReconciliationDiffRecord {
  /** Set for a per-close reconcile; absent for a periodic position sweep. */
  readonly intentId?: string
  readonly symbol: string
  /** Which engine↔venue dimension diverged. */
  readonly dimension: 'fills' | 'position' | 'funding'
  readonly engineValue: number
  readonly venueValue: number
  /** How the diff was resolved: `venue_wins` (money corrected), `desync` (routed to orphan/flatten), `in_tolerance`. */
  readonly resolution: string
  /** Whether the diff was inside the configured tolerance (a beyond-tolerance diff also alerts). */
  readonly withinTolerance: boolean
  /** Reconcile time, epoch ms UTC. */
  readonly ts: number
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
  /** Load the instance's single kill-switch row, or `undefined` if never written (`14` §5 step 5). */
  loadKillSwitch?(): Promise<KillSwitchRecord | undefined>
  /** Upsert an S2 tracker snapshot by `intentId`. */
  upsertTrackerSnapshot?(snapshot: TrackerSnapshotRecord): Promise<void>
  /** Load all tracker snapshots for the instance (consumed by 0370 respawn). */
  loadTrackerSnapshots?(): Promise<readonly TrackerSnapshotRecord[]>
  /** Write one post-trade `pnl` row (insert-once, natural key `intentId`; `15` §1, 0390). A re-delivery is a no-op. */
  upsertPnl?(record: PnlRecordRow): Promise<void>
  /**
   * Overwrite an existing `pnl` row with a venue-corrected one (reconciliation, 0400). Unlike
   * {@link upsertPnl} (insert-once), this wins on the `intentId` conflict, so a money correction lands
   * regardless of whether the sidecar's baseline row was written first (order-independent — `15` §2).
   */
  upsertPnlCorrection?(record: PnlRecordRow): Promise<void>
  /** Load one intent's current `pnl` row, or `undefined` if none — the reconciler's engine-side money truth (0400). */
  loadPnl?(intentId: string): Promise<PnlRecordRow | undefined>
  /** Load the instance's settled funding events for a symbol within a time range (accounting sidecar; 0390). */
  loadFundingEventsForSymbol?(symbol: string, range: FundingEventRange): Promise<readonly FundingEventRecord[]>
  /** Append one reconciliation diff row (surrogate-id, append-many; `15` §2, 0400). */
  upsertReconciliation?(record: ReconciliationDiffRecord): Promise<void>
  /** Load the instance's current persisted positions — the periodic reconcile sweep's engine-side view (0400). */
  loadPositions?(): Promise<readonly PositionRecord[]>
}
