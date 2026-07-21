/**
 * Venue-agnostic order manager (`11_execution_and_account_state.md` §5 order path,
 * §6 order FSM; `00_globals.md` §6 stagger + fill-poll). Sits **behind** the
 * `ExchangeAdapter` port: the engine (core) WALs the intent transition carrying the
 * deterministic `clientOrderId` and calls `exchange.placeOrder` → adapter → this
 * manager → an injected {@link OrderTransport} (WS submit; REST fallback). So
 * WAL-before-side-effect stays the engine's job and this manager adds **no** second
 * WAL — its per-order state is WAL + `getOrder` reconstructable on recovery (0370).
 *
 * Responsibilities, all venue-neutral:
 *  - the per-order **order FSM** (`orderMachine`), advanced idempotently;
 *  - a per-manager **stagger queue** (`00_globals` §6: submits ≥ `staggerMs` apart);
 *  - **precision** re-assertion before submit (`11` §3, belt-and-braces edge check);
 *  - the **REST-fallback / bounded-WS-retry** policy on a transport failure (`11` §5);
 *  - the **fill-poll** safety net (`getOrder` ≤15 polls / 10 s) when the private WS
 *    stream is silent post-ack.
 *
 * OrderUpdate ownership (avoids double-transition): this manager **publishes**
 * producer-side updates (`SUBMITTING` at send, `OPEN` on ack, `REJECTED`/`FAILED` on a
 * failed submit, and any state its fill-poll recovers) and **subscribes** to the bus to
 * advance its FSM + cancel the fill-poll timer when a terminal/fill update arrives
 * (venue-driven ones come from the private stream, 0220). It never re-publishes what it
 * consumed (no loop); duplicate/late updates are absorbed by the FSM's
 * `IllegalTransitionError` (caught + ignored).
 */

import { AdapterError, type ConsecutiveFailureCounter, NetworkError } from '../adapters/shared/errors.js'
import type { OrderUpdate } from '../core/events/types.js'
import { IllegalTransitionError } from '../core/intent/fsm-engine.js'
import type { EventBus, Unsubscribe } from '../core/ports/bus.js'
import type { Clock, TimerHandle } from '../core/ports/clock.js'
import type { Instrument, Order, OrderAck, OrderRequest, OrderStatus } from '../core/ports/exchange-adapter.js'
import type { FeasibilityReason } from '../core/sizing/sizing.js'
import { checkFeasibility, roundPrice } from '../core/sizing/sizing.js'
import { type OrderState, orderMachine } from './order-machine.js'

/**
 * The narrow write-path surface the manager drives — one per venue. Implementations
 * map core requests ↔ venue payloads, apply denomination at the API boundary, and
 * throw a mapped {@link AdapterError} (`WsTimeout` on ack timeout). `submit` is the WS
 * path; `submitRest` the REST fallback (same `clientOrderId`); `getOrder` powers both
 * the fill-poll and adopt-on-retry; `cancel` closes a resting order.
 */
export interface OrderTransport {
  /** Submit over the venue's native WS order API. Rejects with an `AdapterError`. */
  submit(req: OrderRequest): Promise<OrderAck>
  /** REST-fallback submit with the **same** `clientOrderId` (idempotent). */
  submitRest(req: OrderRequest): Promise<OrderAck>
  /** Ground-truth order read by `clientOrderId` (fill-poll + adoption). */
  getOrder(clientOrderId: string): Promise<Order>
  /** Cancel an order by `clientOrderId`. */
  cancel(clientOrderId: string): Promise<void>
}

/** Bounded WS retries before aborting a leg when REST fallback is disabled (spec: "bounded", no integer). */
const MAX_WS_RETRIES = 2
/** Fill-poll ceiling (`00_globals` §6): ≤15 polls within a 10 s window. */
const FILL_POLL_MAX = 15
const FILL_POLL_TIMEOUT_MS = 10_000
/** Cadence chosen to fit ≤15 polls into 10 s (non-spec-governed; ~667 ms). */
const FILL_POLL_CADENCE_MS = 667

/** A transport failure warrants fallback/retry; a venue verdict (reject/margin/auth) does not. */
function isTransportFailure(kind: AdapterError['kind']): boolean {
  return kind === 'WsTimeout' || kind === 'NetworkError' || kind === 'VenueUnavailable'
}

/** Coerce an unknown throw to an `AdapterError` (transports map already; this backstops). */
function asAdapterError(err: unknown): AdapterError {
  return err instanceof AdapterError ? err : new NetworkError(String(err), { cause: err })
}

/** In-flight order tracked by the manager; the durable record is the WAL (engine-owned). */
interface ManagedOrder {
  state: OrderState
  readonly req: OrderRequest
  pollHandle?: TimerHandle
  pollCount: number
}

export interface OrderManagerDeps {
  readonly transport: OrderTransport
  readonly clock: Clock
  readonly bus: EventBus
  /** Resolve the validated {@link Instrument} for the precision re-assert (adapter registry read). */
  readonly resolveInstrument: (symbol: string) => Instrument
  /** Per-venue serialization gap between submits (`00_globals` §6; Binance 100 ms). */
  readonly staggerMs: number
  /** When `true`, a WS-transport failure falls back to REST (adopt-on-retry first); else bounded WS retry. */
  readonly wsOrderRestFallback: boolean
  /** Shared breaker observer (0200): fill-poll `getOrder` errors feed it; 0380 owns the trip. */
  readonly failures?: ConsecutiveFailureCounter
}

export interface OrderManager {
  placeOrder(req: OrderRequest): Promise<OrderAck>
  cancelOrder(clientOrderId: string): Promise<void>
  /** Stop reacting to the bus (adapter close). */
  dispose(): void
}

/** `orderMachine.transition` typed for dynamic (non-literal) `to`; still runtime-validates + throws on illegal. */
const applyOrderTransition = orderMachine.transition as unknown as (from: OrderState, to: OrderState) => void

/** Human-readable precision reject reason → matches the sim/venue `OrderUpdate.reason` dialect. */
type PrecisionCheck =
  | { readonly ok: true; readonly req: OrderRequest }
  | { readonly ok: false; readonly reason: FeasibilityReason }

export function createOrderManager(deps: OrderManagerDeps): OrderManager {
  const { transport, clock, bus, resolveInstrument, staggerMs, wsOrderRestFallback, failures } = deps

  const orders = new Map<string, ManagedOrder>()

  // ── stagger queue ───────────────────────────────────────────────────────────
  // Serialize submits ≥ `staggerMs` apart on the injected Clock. Chained so only one
  // slot reservation runs at a time; each reserves its instant synchronously before
  // awaiting, so the next chained call reads the updated high-water mark.
  let lastSubmitMs = Number.NEGATIVE_INFINITY
  let staggerTail: Promise<void> = Promise.resolve()

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      clock.scheduleTimer(clock.now() + ms, resolve)
    })
  }

  function acquireSlot(): Promise<void> {
    const run = staggerTail.then(() => {
      const now = clock.now()
      const slot = Math.max(now, lastSubmitMs + staggerMs)
      lastSubmitMs = slot
      return slot > now ? sleep(slot - now) : undefined
    })
    // Keep the chain alive even if a slot's sleep rejects (it never does today).
    staggerTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ── publishing ──────────────────────────────────────────────────────────────
  function emit(u: {
    clientOrderId: string
    status: OrderStatus
    fillPx?: number
    qty?: number
    reason?: string
    errorKind?: AdapterError['kind']
  }): void {
    const update: OrderUpdate = {
      type: 'OrderUpdate',
      clientOrderId: u.clientOrderId,
      status: u.status,
      ...(u.fillPx !== undefined ? { fillPx: u.fillPx } : {}),
      ...(u.qty !== undefined ? { qty: u.qty } : {}),
      ...(u.reason !== undefined ? { reason: u.reason } : {}),
      ...(u.errorKind !== undefined ? { errorKind: u.errorKind } : {}),
    }
    bus.publish(update)
  }

  function emitOrder(o: Order): void {
    emit({
      clientOrderId: o.clientOrderId,
      status: o.status,
      ...(o.fillPx !== undefined ? { fillPx: o.fillPx } : {}),
      ...(o.qty !== undefined ? { qty: o.qty } : {}),
    })
  }

  // ── precision (`11` §3, before submit) ───────────────────────────────────────
  function enforcePrecision(req: OrderRequest, instrument: Instrument): PrecisionCheck {
    // Only priced orders (limit/stop) can be tick-rounded and notionally checked here;
    // a market order carries no price, so its feasibility was decided at engine sizing.
    if (req.price === undefined) return { ok: true, req }
    const price = roundPrice(req.price, instrument)
    const feasibility = checkFeasibility(req.qty, price, instrument)
    if (!feasibility.ok) return { ok: false, reason: feasibility.reason }
    return { ok: true, req: { ...req, price } }
  }

  // ── fill-poll safety net (`00_globals` §6 / `11` §5) ─────────────────────────
  function cancelPoll(order: ManagedOrder): void {
    order.pollHandle?.cancel()
    order.pollHandle = undefined
  }

  function scheduleFillPoll(order: ManagedOrder, startMs: number): void {
    order.pollHandle = clock.scheduleTimer(clock.now() + FILL_POLL_CADENCE_MS, () => {
      order.pollHandle = undefined
      if (!orders.has(order.req.clientOrderId)) return // already terminal via a WS update
      if (order.pollCount >= FILL_POLL_MAX || clock.now() - startMs >= FILL_POLL_TIMEOUT_MS) return
      order.pollCount++
      void pollOnce(order, startMs)
    })
  }

  async function pollOnce(order: ManagedOrder, startMs: number): Promise<void> {
    try {
      const o = await transport.getOrder(order.req.clientOrderId)
      failures?.recordSuccess()
      if (orderMachine.isTerminal(o.status)) {
        emitOrder(o) // FILLED/CANCELLED/EXPIRED — the bus handler advances + drops the order
        return
      }
      scheduleFillPoll(order, startMs) // still OPEN/PARTIAL — keep watching
    } catch (err) {
      // Consecutive getOrder errors feed the breaker observer and stop the poll
      // (circuit-open) — the WS stream stays the primary fill signal.
      failures?.record(asAdapterError(err))
    }
  }

  function armFillPoll(order: ManagedOrder): void {
    scheduleFillPoll(order, clock.now())
  }

  // ── submit + REST-fallback / bounded-retry policy (`11` §5) ──────────────────
  async function adopt(clientOrderId: string): Promise<OrderAck | undefined> {
    try {
      const existing = await transport.getOrder(clientOrderId)
      // The venue already accepted it — adopt, no resubmit (idempotent on retry).
      return {
        clientOrderId,
        accepted: existing.status !== 'REJECTED',
        ...(existing.venueOrderId !== undefined ? { venueOrderId: existing.venueOrderId } : {}),
      }
    } catch (err) {
      if (asAdapterError(err).kind === 'NotFound') return undefined // never reached the venue → resubmit
      throw err
    }
  }

  async function recoverSubmit(req: OrderRequest, cause: AdapterError): Promise<OrderAck> {
    // Reduce-only (exit-leg) submits force the REST fallback even with the flag off:
    // protecting an open position outranks the fallback-flag gate (`02` §3). "WS rejection"
    // here is a WS *transport* failure (timeout/network) — the `isTransportFailure` set
    // `submitWithPolicy` already filtered on, matching the entry mechanism; a genuine
    // venue-semantic reject is not REST-recoverable and never reaches this branch.
    if (wsOrderRestFallback || req.reduceOnly === true) {
      const adopted = await adopt(req.clientOrderId)
      if (adopted) return adopted
      return transport.submitRest(req)
    }
    // Flag off (Binance today): bounded WS retry, then abort the leg.
    let last = cause
    for (let attempt = 0; attempt < MAX_WS_RETRIES; attempt++) {
      try {
        return await transport.submit(req)
      } catch (err) {
        const mapped = asAdapterError(err)
        if (!isTransportFailure(mapped.kind)) throw mapped
        failures?.record(mapped)
        last = mapped
      }
    }
    throw last
  }

  async function submitWithPolicy(req: OrderRequest): Promise<OrderAck> {
    try {
      return await transport.submit(req)
    } catch (err) {
      const mapped = asAdapterError(err)
      if (!isTransportFailure(mapped.kind)) throw mapped
      failures?.record(mapped)
      return recoverSubmit(req, mapped)
    }
  }

  /** Publish the terminal verdict for a submit that threw a venue error; return the not-accepted ack. */
  function failSubmit(req: OrderRequest, err: AdapterError): OrderAck {
    const status: OrderStatus =
      err.kind === 'OrderRejected' || err.kind === 'InsufficientBalance' ? 'REJECTED' : 'FAILED'
    emit({
      clientOrderId: req.clientOrderId,
      status,
      errorKind: err.kind,
      ...(err.reason !== undefined ? { reason: err.reason } : {}),
    })
    return { clientOrderId: req.clientOrderId, accepted: false }
  }

  // ── bus subscription: advance the FSM + cancel the poll on terminal/fill ─────
  function onOrderUpdate(event: OrderUpdate): void {
    const order = orders.get(event.clientOrderId)
    if (!order) return // untracked (another intent's order, or a pre-submit precision reject)
    const terminal = orderMachine.isTerminal(event.status)
    if (terminal) cancelPoll(order)
    try {
      applyOrderTransition(order.state, event.status)
      order.state = event.status
    } catch (e) {
      if (!(e instanceof IllegalTransitionError)) throw e // duplicate/late update — ignore
    }
    if (terminal) orders.delete(event.clientOrderId)
  }

  const unsubscribe: Unsubscribe = bus.subscribe((event) => {
    if (event.type === 'OrderUpdate') onOrderUpdate(event)
  })

  return {
    async placeOrder(req: OrderRequest): Promise<OrderAck> {
      const precision = enforcePrecision(req, resolveInstrument(req.symbol))
      if (!precision.ok) {
        // Never let the venue be first to reject a malformed order (`11` §3).
        emit({
          clientOrderId: req.clientOrderId,
          status: 'REJECTED',
          errorKind: 'OrderRejected',
          reason: precision.reason,
        })
        return { clientOrderId: req.clientOrderId, accepted: false }
      }
      const finalReq = precision.req

      await acquireSlot() // stagger
      const order: ManagedOrder = { state: 'NEW', req: finalReq, pollCount: 0 }
      orders.set(finalReq.clientOrderId, order)
      emit({ clientOrderId: finalReq.clientOrderId, status: 'SUBMITTING' }) // handler: NEW→SUBMITTING

      let ack: OrderAck
      try {
        ack = await submitWithPolicy(finalReq)
      } catch (err) {
        return failSubmit(finalReq, asAdapterError(err)) // handler: SUBMITTING→REJECTED/FAILED, drops
      }
      if (!ack.accepted) {
        emit({ clientOrderId: finalReq.clientOrderId, status: 'REJECTED', errorKind: 'OrderRejected' })
        return ack
      }
      emit({ clientOrderId: finalReq.clientOrderId, status: 'OPEN' }) // handler: SUBMITTING→OPEN
      if (orders.has(finalReq.clientOrderId)) armFillPoll(order) // still open (not already filled by a raced WS event)
      return ack
    },

    async cancelOrder(clientOrderId: string): Promise<void> {
      try {
        await transport.cancel(clientOrderId)
      } catch (err) {
        const mapped = asAdapterError(err)
        // An already-filled/gone order → venue NotFound: resolve to truth, not an error (`11` §6).
        if (mapped.kind !== 'NotFound') throw mapped
        try {
          emitOrder(await transport.getOrder(clientOrderId))
        } catch {
          // Truth unavailable too — nothing to reconcile; the stream/poll will settle it.
        }
      }
    },

    dispose(): void {
      for (const order of orders.values()) cancelPoll(order)
      unsubscribe()
    },
  }
}
