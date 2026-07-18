# 0110 — Exchange profiles, per-exchange deltas, loading pipeline

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0100
**Spec references:** `09_configuration.md` §4 (exchange profile), §5 (loading & validation pipeline), §6 (cross-cutting validations), §7 (change management); `00_globals.md` §6 (per-exchange deltas)

## Objective
The complete fail-loud startup config pipeline: `.env` → strategy YAML → `exchanges.yaml` profile → delta merge → re-validation → cross-checks → frozen `EffectiveConfig`, plus the config revision hash. After this task, an instance's entire behavior is derivable from validated, immutable config.

## Context for the agent
Deltas (`00_globals` §6): any exchange profile may override `fundingFeeTimeoutSeconds`, `leverage` (per strategy), or `ws_order_rest_fallback`; applied **after** base validation and **re-validated against the same bounds** so a delta can never silently push a value out of range. Cross-checks (`09` §6): co-run guard (from 0100), WS-mandatory guard (S1-WS/S2/S6 need a WS order adapter unless the profile sets `ws_order_rest_fallback: true`), sizing feasibility soft-warn, `deadline_seconds ≥ funding_fee_timeout_seconds` (S2/S6), secret presence per selected exchange. Any failure: log exact key + reason, `process.exit(1)` before any exchange call.

## Scope
- In scope:
  - `config/exchanges.yaml` with all six venues per `09` §4 shape (fees, `submission_stagger_ms` — Bybit 150, Binance 100, others 100; `rate_limit_reserve_pct: 10`; ws endpoints; `deltas`).
  - `ExchangeProfileSchema` (Zod) and the delta-merge + re-validate step.
  - `src/config/load.ts`: the 6-step pipeline from `09` §5 producing a deep-frozen `EffectiveConfig`; step 6 (instrument validation) is a pluggable hook invoked later by adapter init (0190) — define the interface, no venue call here.
  - Config revision hash (stable hash of effective config minus secrets) exposed on `EffectiveConfig` (`09` §7); secrets wrapped and Pino-redaction patterns declared (`*_SECRET`, `*_KEY`, `*_PASSPHRASE`).
  - All `09` §6 cross-checks wired with unit tests each.
- Out of scope: hot reload (explicitly forbidden), instrument validation implementation (0190), consuming `EffectiveConfig` in the engine (0130+), fleet config generation (0520).

## Implementation notes
`EffectiveConfig` passed by value into the composition root; nothing reads disk after startup. Keep `process.exit` at the outermost CLI boundary only — the library function throws a typed `ConfigError {key, reason}` so tests can assert without spawning processes. Hash: sha256 over stable-stringified config; exclude secrets.

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit tests: a delta `funding_fee_timeout_seconds: 45` lands in effective config; a delta pushing a value out of bounds fails; S2 selected on a profile without WS order adapter and without the fallback flag → startup error; `deadline_seconds < funding_fee_timeout_seconds` on S6 → error; missing `BINANCE_API_SECRET` with `EXCHANGE=binance` → error naming the key.
3. Same config in → same revision hash out (test), different param → different hash.
4. `EffectiveConfig` is frozen: mutation attempt throws in tests (`'use strict'` semantics).
