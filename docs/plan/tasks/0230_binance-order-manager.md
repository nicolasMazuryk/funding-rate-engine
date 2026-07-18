# 0230 — Binance order manager: WS-first, REST fallback, idempotent

**Phase:** 3 — Binance adapter
**Depends on:** 0070, 0120, 0220
**Spec references:** `11_execution_and_account_state.md` §2–§6 (sizing enforcement, idempotency, order path, order FSM); `00_globals.md` §6 (stagger, WS-mandatory, fill-poll); `10_exchange_adapters_and_market_data.md` §5 (WsTimeout handling)

## Objective
The venue-facing write path: `placeOrder`/`cancelOrder` over the native WS order adapter with REST fallback gated by the profile's `ws_order_rest_fallback` flag, deterministic `clientOrderId = f(intentId, leg, attempt)`, WAL append before submission, per-venue submission stagger, `OrderUpdate`-driven order-FSM wiring with the REST fill-poll safety net (10 s timeout, ≤ 15 polls), and precision enforcement on every outgoing order.

## Context for the agent
Idempotency is the heart (`11` §4): the WAL records `clientOrderId` **before** submission; on fallback/reconnect the engine re-queries by `clientOrderId` and **adopts** an accepted order instead of resubmitting — exactly-once in effect. Fallback policy (`11` §5): on `WsTimeout`/WS error, REST fallback only if the profile flag is set; otherwise bounded WS retry then abort the leg (`OrderRejected`/`main_order_failed` path). Stagger: serialize multi-order placements per venue (Binance 100 ms) — matters for ladders. Order submits go through the 0200 order lane. Every outgoing order passes 0120 checks (tick round, lot floor, min-notional) — the venue should never be the first to tell us an order is malformed.

## Scope
- In scope:
  - `src/execution/order-manager.ts` (venue-agnostic orchestration) + `src/adapters/exchanges/binance/ws-orders.ts` (native WS submit/cancel; REST via ccxt).
  - `clientOrderId` scheme (deterministic, venue-length-safe, parseable back to `(intentId, leg, attempt)`).
  - Order FSM (0040 table) live wiring: submit → ack → `OrderUpdate` transitions; fill-poll fallback when no event arrives in-window; `PARTIAL` handling; cancel/expiry paths; every transition WAL-appended before its side effect.
  - Stagger queue per venue from profile config.
  - Recovery-support query: `findByClientOrderId` (REST `getOrder`) used by adoption logic (full recovery sequence is 0370 — here implement adopt-on-retry within a session).
  - Sim + unit tests (order manager against the sim venue with 0160 faults: WS timeout with and without fallback flag, duplicate `OrderUpdate`, reject mapping to error codes); env-gated testnet test: place + cancel a far-from-market limit order via WS, retry same `clientOrderId` → no duplicate.
- Out of scope: account setup + trackers (0240), OCO/sweep strategy semantics (strategy tasks), circuit breaker (0380), full crash recovery (0370).

## Implementation notes
The order manager is used by all venues — only the WS-submit transport is Binance-specific; keep the split clean now and 0420–0460 stay small. Fill-poll circuit-opens on consecutive errors (`00_globals` §6) — count and expose to the breaker observer (0200). Cancel of an already-filled order → `NotFound` → resolve via `getOrder` truth, not an error.

## Verification (definition of done)
1. `npm run verify` — green: sim tests prove WS-timeout+flag → REST fallback used once, same `clientOrderId`, no duplicate order in sim venue state; WS-timeout without flag → bounded retries then leg abort with correct error code; duplicate `OrderUpdate` events do not double-transition the FSM; stagger enforces ≥ 100 ms spacing on virtual clock for a 3-order batch.
2. WAL ordering test: the WAL record for `SUBMITTING` exists before the sim adapter sees the submit call (hook-order assertion).
3. Env-gated testnet: limit order placed via WS at an unfillable price, `getOrder` by `clientOrderId` confirms `OPEN`, resubmit attempt adopts (no second venue order), cancel confirms `CANCELLED`; suite skips without credentials.
