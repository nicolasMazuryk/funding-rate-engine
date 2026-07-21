# STATUS — Task Ledger

One row per task. Agents update this file only (see `docs/plan/EXECUTION.md`). Statuses: `todo` | `in_progress` | `done` | `blocked`. **Notes = forward-looking signal only** — deferrals, spec deviations, cross-cutting decisions, and gotchas a later task needs. Anything derivable from the code, specs, or commit/PR does NOT belong here. Keep terse.

| ID | Task | Status | Notes |
|---|---|---|---|
| 0010 | repo-scaffold-and-verify | done | Layout uses `src/persistence/` (deviates from spec 08 §7), per user. |
| 0020 | agent-context-layer | done | |
| 0030 | core-events-and-ports | done | |
| 0040 | fsm-engine | done | ASSUMPTION (flagged for review): `NO_POSITION` reachable from `SUBMITTING_ENTRY`+`MONITORING`, not `MONITORING`-only per spec 12 §5 diagram. |
| 0050 | clock-and-scheduler | done | |
| 0060 | fake-adapter-minimal | done | Funding-sign convention: `signedFundingPct = long ? -rate : rate` (00_globals §1.1/§3.1). |
| 0070 | local-wal | done | |
| 0080 | postgres-drizzle-minimal | done | Watermark re-derived from `MAX(seq)`, no sidecar (relevant to 0370). `Repo` port surface not final. |
| 0090 | walking-skeleton-slice | done | Stub strategy replaced by real S1 in 0280. DECISION: engine does NOT use `intentMachine.onTransition` (global singleton leaks across engine instances). Repo pool `max:1` gotcha: un-awaited upserts must serialize or a late MONITORING overwrites CLOSED (0360/0370). |
| 0100 | config-canonical-schema | done | `amountUsd`/`mainAmountUsd` two canonical rows sharing on-disk `sizing.amount_usd`, resolved key differs by strategy (0280+, 0350). Strategy ids are short (`s1`,`s1-ws`,…), NOT spec 09's `strategy_1_ws` form — governing convention. S6 legacy alias `funding_threshold`→`funding_threshold_percent` (0350). `config/*.yaml` values are PROPOSED, not final. |
| 0110 | config-exchange-profiles | done | Per-strategy leverage nested (`leverage: {s1: 4}`), not spec's flat form. WS-order guard = `wsOrderAdapter\|\|wsOrderRestFallback` (0300/adapters). Non-Binance WS URLs are placeholders, fix in 0420–0460. |
| 0120 | sizing-precision-denomination | done | Sizing lives in `src/core/sizing/` (not task file's `src/execution/sizing.ts`; purity lint blocks core→execution, user-confirmed) — strategies 0280+ import from here. |
| 0130 | guards-and-opportunity-finder | done | Funding schedule is DERIVED (no funding feed/port yet — 0210 adds it, also 0290). Threshold direction is an explicit `'negative'\|'positive'` config field (S6's positive `0` threshold makes sign inference ambiguous) — affects all strategies incl. S6 0350. |
| 0140 | preflight-risk-gate-kill-switch | done | Fail-closed: unknown price→skip, unknown balance→reject; engine balance defaults `undefined`, real `main.ts` must fetch it. DEFERRED: `max_daily_loss_usd` parsed, NOT enforced (needs realized-P&L, 0390); `breakerOpen` hardcoded `false` until 0380; `accountSetupComplete` defaults `true`, real producer 0240. |
| 0150 | cost-model | done | Covers one canonical exit path per family; S2/S3a sl/deadline paths uncovered (helpers expose them) — 0310/0320. Load-time economic gate is Group L only (s1/s1-ws/s2); Group S/R/D uneconomic TP NOT caught at load. Cost breakdown is in-memory only, NOT in WAL — revisit if 0370/0410 need it persisted. |
| 0160 | sim-exchange-fault-injection | done | Venue-error faults exercised via direct `sim.*()` calls, NOT through the engine (`placeOrder` is fire-and-forget); `VenueErrorKind`/`scriptRateLimit` are stubs, NO token bucket — 0200 adds the real taxonomy + rate limiter + order-FSM raising. `OrderType` widened with `'stop'` (no consumer yet — S2/S3a/S4.x). |
| 0170 | replay-and-trace | done | Node CLI entries need the zero-dep resolve hook (`scripts/register-ts.mjs`) + `--experimental-transform-types`; a real `main.ts` will need this too. Trace header snapshots interim config, not full `EffectiveConfig` (no `main.ts`) — revisit at config-loading composition. |
| 0180 | claude-workflows-and-hooks | done | |
| 0190 | binance-clients-and-markets | done | `fundingIntervalHours` per-symbol cross-check via `fapi/v1/fundingInfo` landed 0210-era suggestion drain — see 0210 note. COLLISION: Binance lists both plain + multiplier tickers (real: `CATUSDT`+`1000CATUSDT`) folding to one canonical name — registry keeps the plainer listing, drops the other (not an abort); needs a real disambiguation policy (SUGGESTIONS). `createInstrumentValidationHook(adapter)` NOT wired (no `main.ts`). |
| 0200 | error-taxonomy-and-rate-limiter | done | `createConsecutiveFailureCounter` exposes the breaker OBSERVER only (0380 owns the trip). `rate-limiter.ts`: order lane may borrow idle general, general NEVER borrows the reserve; general lane DELAYS, order lane THROWS `RateLimited` (no queue). Non-Binance `rate_limit_weight_per_minute` still 2400 placeholders → 0420–0460 (SUGGESTIONS). Order-lane not yet wired into `placeOrder`/`cancelOrder` — 0230 consumes it. |
| 0210 | binance-public-ws | done | Adapter deps gained `ws?`/`bus?` — BOTH required to wire the stream; absent → throws (0190/0200 offline tests unaffected). `src/adapters/shared/reconnect.ts` FSM (`live\|degraded\|repriming`) — REUSE for 0220+every venue. Non-Binance WS URLs/keys still placeholders (0420–0460). `FundingSettled`/funding-gate = 0290. |
| 0220 | binance-private-ws | done | WS `BalanceUpdate` is APPROXIMATE (`free=crossWalletBalance`, `used=max(0,walletBalance−crossWalletBalance)`); ccxt `getBalance` is authoritative (reprime+preflight) — drive off REST if a consumer ever needs the exact live split (SUGGESTIONS). Adapter deps gained `wsPrivate?` — BOTH `wsPrivate`+`bus` required to wire. Degraded poll = positions+balance only (no order poll — fills uncatchable cheaply). `getOrder` symbol map is NOT persisted — after a crash/restart, a pre-restart order's `getOrder` fails until `ORDER_TRADE_UPDATE` re-populates it (SUGGESTIONS). ccxt USD-M `setSandboxMode` deprecated → merge `urls.test` into `urls.api`. `FundingSettled`/funding gate = 0290. |
| 0230 | binance-order-manager | done | Order manager adds NO 2nd WAL — state is WAL+`getOrder` reconstructable, full recovery=0370. Order-lane rate-limit + error-map done in the ADAPTER (`callOrder`), not the manager, so the manager stays limiter-agnostic. `capReduceOnlyQty` SKIPPED here (manager tracks no positions — tracker/preflight's job, 0240; still not applied there either, SUGGESTIONS). NON-SPEC CONSTANTS (`FILL_POLL_CADENCE_MS=667`, `MAX_WS_RETRIES=2`, `WS_ACK_TIMEOUT_MS=5000`) are smallest-reasonable defaults — confirm/pin when the risk/latency budget is set (breakers 0380). Fill-poll STOPS on the first `getOrder` error (SUGGESTIONS: revisit a small local retry once 0380 degraded-mode wiring lands). WS-API reject code nests at `err.error.code` — `ws-orders.liftWsApiError` hoists it; cross-venue trap if a second venue's WS-API (0420–0460) nests differently (SUGGESTIONS). Adopt-on-retry + REST fallback are flag-OFF for Binance (WS-mandatory) → unit-tested on the fake transport only. |
| 0240 | account-setup-and-trackers | done | `OrphanDetected` is a NEW core-bus `EngineEvent` variant — tracker PUBLISHES it, 0380's risk layer SUBSCRIBES + owns auto-flatten (engine `dispatch` no-ops it today). `accountSetupComplete` engine dep widened `boolean → boolean\|((symbol)=>boolean)`. Trackers hold no WAL (REST-rebuildable). Orphan handling/auto-flatten (0380) + Postgres reconciliation records (0400) OUT of scope here. |
| 0250 | fixture-capture | done | Standing sanity check: `grep -rIE 'api|secret|[A-Za-z0-9+/]{40,}={0,2}' test/fixtures/binance/`. `public-ws`/`private-ws`/`orders` capture live time-varying data, NOT expected byte-stable rerun-to-rerun (only `markets` is idempotent). |
| 0260 | binance-testnet-tier | done | Testnet eventual-consistency lag (occasional `-2013` immediately after submit/cancel) — `order-path`'s post-mutation `getOrder` reads wrapped in `retry()`; documented in `docs/testnet-notes.md` alongside other venue divergences. |
| 0270 | e2e-harness | done | Exit-policy seam (`src/core/intent/exit-policy.ts`): MONITORING dispatches to a handler resolved by `exitPolicyKind` via a registry — 0280 plugs in the real `timed` kind with zero engine edits (skeleton's `TIMED_PLACEHOLDER_HANDLER` is the stand-in). E2E harness in `test/e2e/harness.ts` (sim venue + virtual clock + real Docker Postgres + real local WAL), grown per strategy from 0280. DEVIATIONS (all user-confirmed): (a) NO `src/composition.ts` yet — reuse `buildSkeletonEngine`, extract in 0280 when `main.ts` needs it; (b) boot from interim `RuntimeStrategyConfig`, not `EffectiveConfig` (resolver is 0280 composition-root work); (c) `test/integration/skeleton-e2e.test.ts` REMOVED — coverage migrates to `test/e2e/`. Behavior-preserving refactor: golden + determinism byte-identical. |
| 0280 | strategy-s1 | todo | |
| 0290 | funding-gate | todo | |
| 0300 | strategy-s1-ws | todo | |
| 0310 | strategy-s2 | todo | |
| 0320 | strategy-s3a | todo | |
| 0330 | strategy-s4-1a | todo | |
| 0340 | strategy-s4-2a | todo | |
| 0350 | strategy-s6 | todo | |
| 0360 | postgres-schema-full | todo | |
| 0370 | crash-recovery-full | todo | |
| 0380 | breakers-and-flatten | todo | |
| 0390 | accounting | todo | |
| 0400 | reconciliation | todo | |
| 0410 | analytics | todo | |
| 0420 | adapter-bybit | todo | |
| 0430 | adapter-okx | todo | |
| 0440 | adapter-bitget | todo | |
| 0450 | adapter-gateio | todo | |
| 0460 | adapter-kucoin | todo | |
| 0470 | live-tier-harness | todo | |
| 0480 | live-verification-binance | todo | |
| 0490 | s6-shadow | todo | |
| 0500 | s6-canary | todo | |
| 0510 | docker-fleet-packaging | todo | |
| 0520 | fleet-config-and-runbook | todo | |
| 0530 | ci-pipeline | todo | |
