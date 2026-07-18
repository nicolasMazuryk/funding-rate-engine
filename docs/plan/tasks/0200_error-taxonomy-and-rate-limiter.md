# 0200 — Typed error taxonomy + weighted rate limiter

**Phase:** 3 — Binance adapter
**Depends on:** 0190
**Spec references:** `10_exchange_adapters_and_market_data.md` §5 (error taxonomy), §6 (rate limiter); `00_globals.md` §6 (10% order-lane reservation); `08_system_overview.md` §5 (Circuit Breaker pattern placement)

## Objective
The shared typed error set (`RateLimited`, `WsTimeout`, `OrderRejected`, `InsufficientBalance`, `AuthError`, `NetworkError`, `NotFound`, `VenueUnavailable`) with the Binance mapping table, and the per-exchange token-bucket rate limiter with endpoint weights and a 10% reserve for order submit/cancel. Every later adapter reuses both; every venue error the core ever sees is one of these eight.

## Context for the agent
Raw venue codes are logged, never leaked into core logic (`10` §5). Mapping tables live per adapter; the union type is shared (put it where both core and adapters can import — error *types* are core-visible, mapping is adapter-local). Limiter rules (`10` §6): weight-accounted (ccxt exposes weights); on depletion, queue/delay non-critical calls but **never silently drop an order submit** — an exhausted order lane raises `RateLimited` to the order FSM; REST and WS-order submission share accounting where the venue counts both. One limiter per adapter instance (one sub-account). `AuthError` is fatal at startup (fail-loud).

## Scope
- In scope:
  - `src/adapters/shared/errors.ts`: the eight typed errors (discriminated union or class hierarchy) with `retryable` semantics per `10` §5 handling column; consecutive-failure counting surface for the future breaker (0380) — expose an observer, don't implement the breaker.
  - `src/adapters/exchanges/binance/error-map.ts`: mapping from ccxt error classes + Binance REST/WS codes (cover at minimum: 429/418 → `RateLimited`; -2010/-4164-class order rejects incl. min-notional/precision/reduce-only → `OrderRejected` with reason; -2019/margin → `InsufficientBalance`; auth codes → `AuthError`; 5xx/maintenance → `VenueUnavailable`; unknown order → `NotFound`; socket/timeouts → `NetworkError`/`WsTimeout`), defaulting unknown codes to `NetworkError`(retryable) with the raw code logged.
  - `src/adapters/shared/rate-limiter.ts`: token bucket with weights, two lanes (order lane = reserved 10%, general lane = 90%), queue with delay for general lane, immediate `RateLimited` when the order lane cannot admit, budget sizing from `exchanges.yaml`.
  - Wrap 0190's REST calls with limiter + error mapping.
  - Unit tests with a virtual clock (bucket refill is time-based).
- Out of scope: circuit breaker (0380), WS reconnect policy (0210/0220), per-venue maps for other exchanges (0420–0460).

## Implementation notes
Model the reserve as two buckets fed from one refill: general lane capacity 90%, order lane 10% + spillover access to the general lane if idle (order lane may borrow; general may never borrow from order lane — that's the guarantee). Weights: take a `weight` per call, default 1. Keep the limiter clock-injected for tests.

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit tests: saturating the general lane with polling never delays an order submit while order-lane tokens remain; exhausting the order lane raises `RateLimited` (not a silent queue); refill over virtual time restores capacity; weighted call consumes proportionally.
3. Mapping tests: table-driven — each listed Binance code produces the expected typed error and never a raw throw; unknown code → `NetworkError` + logged raw code.
