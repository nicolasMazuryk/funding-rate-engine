/**
 * Funding gate (task 0290; `00_globals.md` §6 REST poll + grace, §1.1 `T_settle`/`T_drop`,
 * §8.3 `t_drop_offset_s`; `02_strategy_1_ws.md` §2/§3 gate mechanics; `11` §7 funding
 * tracking). Pure core — the shared primitive the WS-gated strategies (S1-WS/S2/S6, tasks
 * 0300/0310/0350) each plug their exit policy into.
 *
 * The gate answers one question per monitoring intent: *did the funding I bet on actually
 * accrue, and when?* Per armed intent it opens on **whichever lands first, once only**:
 *  - the matched WS `funding_fee` event (`onFundingFee`) — within ±5 s of `T_settle`, or
 *  - a REST funding-**income** poll at `T_settle + 3 s` observing the account credit
 *    (the safety net when the WS event is missed).
 * If neither lands it fires a `timeout` signal at `T_settle + timeoutSeconds`. It also
 * computes `t_drop_offset_s = (T_drop − T_settle)/1000` for analytics.
 *
 * Mirrors {@link ../../execution/order-manager.ts}'s in-core fill-poll shape: an injected
 * transport port ({@link FundingIncomePoll}) + `clock.scheduleTimer` + async poll +
 * `dispose()`. Time/poll are **ports**, so calling them from core is pure. The bus
 * subscription that feeds WS events is the *caller's* job (the scenario harness here; the
 * engine in 0300) — the gate takes explicit `onFundingFee` calls and never imports the bus.
 *
 * **Idempotency is the correctness guarantee** (cancel-on-open is only an optimization):
 * every entry point guards on gate status, so a duplicate WS event, a late poll after open,
 * and a timeout-after-open all no-op.
 */

import type { FundingFeeAccrued } from '../events/types.js'
import type { Clock, TimerHandle } from '../ports/clock.js'
import type { FundingIncome, TimeRange } from '../ports/exchange-adapter.js'

/**
 * Match tolerance between an observed `T_drop` and the intent's `T_settle` (`00_globals.md`
 * §6 / `02` §3): a funding credit within ±5 s (**inclusive**) is *this* settlement's.
 *
 * NOTE: `11` §7 states ±30 s; that is superseded by ROADMAP A1 (binding) — globals §6 and
 * the S1-WS strategy file both fix ±5 s, and the tight tolerance is itself an intended
 * failure mode (`02` §3). ±5 s is the value here.
 */
const FUNDING_MATCH_TOLERANCE_MS = 5000
/** REST safety-net poll fires at `T_settle + 3 s` (`00_globals.md` §6). */
const REST_POLL_OFFSET_MS = 3000
/** Upper bound of the poll query window past the poll instant — the "8 s grace" (`00_globals.md` §6). */
const REST_POLL_GRACE_MS = 8000

/** Which signal opened the gate. */
export type GateOpenSource = 'ws' | 'rest'

/** Gate opened — the funding was observed. Carries the `T_drop` offset for analytics (`00` §8.3). */
export interface GateOpened {
  readonly type: 'GateOpened'
  readonly intentId: string
  readonly source: GateOpenSource
  /** `(T_drop − T_settle)/1000`, seconds; `0` on the REST path (credit `fundingTime = T_settle`). */
  readonly tDropOffsetS: number
}

/**
 * Gate finalized. `opened` follows a {@link GateOpened} (the funding landed); `timeout`
 * is the standalone verdict when neither WS nor REST observed it in time (`02` §2).
 */
export interface GateClosed {
  readonly type: 'GateClosed'
  readonly intentId: string
  readonly reason: 'opened' | 'timeout'
}

/** Everything the gate emits to its caller (the exit policy in 0300; the harness here). */
export type GateSignal = GateOpened | GateClosed

/** REST funding-income read — the safety-net port ({@link ../ports/exchange-adapter.ts}.fundingIncome). */
export type FundingIncomePoll = (symbol: string, range: TimeRange) => Promise<FundingIncome[]>

/** Register one intent's gate against its settlement. `timeoutSeconds` is an arm param (config wiring is 0300). */
export interface GateArm {
  readonly intentId: string
  readonly symbol: string
  /** `T_settle`, epoch ms UTC. */
  readonly settleTs: number
  /** Timeout horizon past `T_settle`, seconds. */
  readonly timeoutSeconds: number
}

/** Serializable per-gate state for crash recovery (persistence of `t_drop_offset_s` defers to 0300/0390). */
export interface GateSnapshot {
  readonly intentId: string
  readonly symbol: string
  readonly settleTs: number
  readonly timeoutSeconds: number
  readonly status: 'armed' | 'open' | 'closed'
  /** Observed `T_drop`, epoch ms UTC — present once opened. */
  readonly observedFundingTime?: number
  readonly source?: GateOpenSource
}

export interface FundingGate {
  /** Register + schedule the REST poll (`T_settle+3 s`) and the timeout (`T_settle+timeoutSeconds`). */
  arm(arm: GateArm): void
  /** Feed a private-WS funding-fee event; opens the first armed gate it matches (±5 s). */
  onFundingFee(event: FundingFeeAccrued): void
  /** Snapshot every gate for the WAL/recovery payload. */
  serialize(): GateSnapshot[]
  /** Rehydrate gates; re-arms (re-schedules) only those still `armed`, others restore inert. */
  restore(snapshots: readonly GateSnapshot[]): void
  /** Has this intent's gate opened? */
  isOpen(intentId: string): boolean
  /** Cancel all pending timers (adapter close). */
  dispose(): void
}

interface GateState {
  readonly intentId: string
  readonly symbol: string
  readonly settleTs: number
  readonly timeoutSeconds: number
  status: 'armed' | 'open' | 'closed'
  observedFundingTime?: number
  source?: GateOpenSource
  pollHandle?: TimerHandle
  timeoutHandle?: TimerHandle
  /** True while the async REST poll is awaiting — the timeout holds rather than pre-empting it. */
  pollInFlight: boolean
  /** The timeout fired while a poll was in flight; finalize once the poll resolves without opening. */
  timeoutPendingPoll: boolean
}

export interface FundingGateDeps {
  readonly clock: Clock
  readonly poll: FundingIncomePoll
  /** Sink for {@link GateSignal}s — the exit policy (0300) / the scenario harness. */
  readonly observer: (signal: GateSignal) => void
}

export function createFundingGate(deps: FundingGateDeps): FundingGate {
  const { clock, poll, observer } = deps
  const gates = new Map<string, GateState>()

  function cancelTimers(state: GateState): void {
    state.pollHandle?.cancel()
    state.pollHandle = undefined
    state.timeoutHandle?.cancel()
    state.timeoutHandle = undefined
  }

  /** Finalize an armed gate as open (WS or REST), emit `opened` + `closed{opened}`, drop timers. */
  function open(state: GateState, source: GateOpenSource, observedFundingTime: number): void {
    if (state.status !== 'armed') return // idempotent: a raced second signal no-ops
    state.status = 'open'
    state.source = source
    state.observedFundingTime = observedFundingTime
    cancelTimers(state)
    observer({
      type: 'GateOpened',
      intentId: state.intentId,
      source,
      tDropOffsetS: (observedFundingTime - state.settleTs) / 1000,
    })
    observer({ type: 'GateClosed', intentId: state.intentId, reason: 'opened' })
  }

  /** Finalize an armed gate as timed-out; no-op if already open/closed. */
  function finalizeTimeout(state: GateState): void {
    if (state.status !== 'armed') return
    state.status = 'closed'
    cancelTimers(state)
    observer({ type: 'GateClosed', intentId: state.intentId, reason: 'timeout' })
  }

  /**
   * Single-shot REST safety net: read funding income around `T_settle`; a row within ±5 s
   * opens `rest`. The 8 s grace is the query window's upper bound — a bounded re-poll for a
   * genuinely late live credit is the adapter/0300 concern, not modelled here.
   */
  function runPoll(state: GateState): void {
    if (state.status !== 'armed') return // WS already opened, or restored inert
    state.pollInFlight = true
    const range: TimeRange = {
      fromTs: state.settleTs - FUNDING_MATCH_TOLERANCE_MS,
      toTs: state.settleTs + REST_POLL_OFFSET_MS + REST_POLL_GRACE_MS,
    }
    poll(state.symbol, range).then(
      (rows) => {
        state.pollInFlight = false
        if (state.status !== 'armed') return
        const match = rows.find((r) => Math.abs(r.fundingTime - state.settleTs) <= FUNDING_MATCH_TOLERANCE_MS)
        if (match) {
          open(state, 'rest', match.fundingTime)
          return
        }
        // No credit yet: if the timeout fired while we were in flight, finalize it now.
        if (state.timeoutPendingPoll) finalizeTimeout(state)
      },
      () => {
        // Poll error is non-fatal and single-shot; release a timeout that was held for it.
        state.pollInFlight = false
        if (state.timeoutPendingPoll) finalizeTimeout(state)
      },
    )
  }

  /**
   * Timeout callback. Correctness landmine: the poll is async but timer callbacks are
   * synchronous, so on a both-timers-past-due restore the timeout could finalize before an
   * in-flight poll resolves and opens. Guard: hold the timeout while a poll is in flight;
   * the poll's resolution finalizes it if no credit was found.
   */
  function onTimeout(state: GateState): void {
    if (state.status !== 'armed') return
    if (state.pollInFlight) {
      state.timeoutPendingPoll = true
      return
    }
    finalizeTimeout(state)
  }

  function schedule(state: GateState): void {
    state.pollHandle = clock.scheduleTimer(state.settleTs + REST_POLL_OFFSET_MS, () => {
      state.pollHandle = undefined
      runPoll(state)
    })
    state.timeoutHandle = clock.scheduleTimer(state.settleTs + state.timeoutSeconds * 1000, () => {
      state.timeoutHandle = undefined
      onTimeout(state)
    })
  }

  return {
    arm(arm: GateArm): void {
      const state: GateState = {
        intentId: arm.intentId,
        symbol: arm.symbol,
        settleTs: arm.settleTs,
        timeoutSeconds: arm.timeoutSeconds,
        status: 'armed',
        pollInFlight: false,
        timeoutPendingPoll: false,
      }
      gates.set(arm.intentId, state)
      schedule(state)
    },

    onFundingFee(event: FundingFeeAccrued): void {
      for (const state of gates.values()) {
        if (state.status !== 'armed' || state.symbol !== event.symbol) continue
        if (Math.abs(event.fundingTime - state.settleTs) > FUNDING_MATCH_TOLERANCE_MS) continue
        open(state, 'ws', event.fundingTime)
        return
      }
    },

    serialize(): GateSnapshot[] {
      return [...gates.values()].map((s) => ({
        intentId: s.intentId,
        symbol: s.symbol,
        settleTs: s.settleTs,
        timeoutSeconds: s.timeoutSeconds,
        status: s.status,
        ...(s.observedFundingTime !== undefined ? { observedFundingTime: s.observedFundingTime } : {}),
        ...(s.source !== undefined ? { source: s.source } : {}),
      }))
    },

    restore(snapshots: readonly GateSnapshot[]): void {
      for (const snap of snapshots) {
        const state: GateState = {
          intentId: snap.intentId,
          symbol: snap.symbol,
          settleTs: snap.settleTs,
          timeoutSeconds: snap.timeoutSeconds,
          status: snap.status,
          ...(snap.observedFundingTime !== undefined ? { observedFundingTime: snap.observedFundingTime } : {}),
          ...(snap.source !== undefined ? { source: snap.source } : {}),
          pollInFlight: false,
          timeoutPendingPoll: false,
        }
        gates.set(snap.intentId, state)
        // Only still-armed gates re-schedule; past-due timers fire on the next tick per the
        // Clock contract, so "never opened → timeout immediately" falls out for free.
        if (state.status === 'armed') schedule(state)
      }
    },

    isOpen(intentId: string): boolean {
      return gates.get(intentId)?.status === 'open'
    },

    dispose(): void {
      for (const state of gates.values()) cancelTimers(state)
    },
  }
}
