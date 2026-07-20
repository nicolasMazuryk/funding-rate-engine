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
| 0080 | postgres-drizzle-minimal | done | Dev instance triple hardcoded (`DEV_INSTANCE`=sim/s1/dev), no `main.ts` composition yet. Watermark re-derived from `MAX(seq)`, no sidecar (relevant to 0370). `Repo` port surface (`upsertIntentState`, optional `IntentSnapshot` fields) is current, not final. |
| 0090 | walking-skeleton-slice | done | Stub strategy (fixed-qty, long-only, timed exit) replaced by real S1 in 0280. DECISION: engine does NOT use `intentMachine.onTransition` (global singleton leaks across engine instances in crash tests); WAL/repo writes inline in `commit()`, preserving WAL-before-side-effect. WAL payload (`EnginePayload`) is self-sufficient — `recoveredFromWal()` rebuilds from WAL alone (0370). Repo pool `max:1` gotcha: un-awaited upserts must serialize or a late MONITORING overwrites CLOSED (0360/0370). |
| 0100 | config-canonical-schema | done | `amountUsd`/`mainAmountUsd` are two canonical rows sharing on-disk `sizing.amount_usd` (S6 resolves `mainAmountUsd`); resolved live key differs by strategy (0280+, 0350). Strategy ids are short (`s1`,`s1-ws`,…) matching `StrategyId`, NOT spec 09's `strategy_1_ws` form — governing convention. S6 legacy alias `funding_threshold`→`funding_threshold_percent` (0350); parser returns `warnings[]` (Zod has no warning channel). `checkCoRunGuard` pure, not wired (no composition root). `config/*.yaml` values are PROPOSED, not final. |
| 0110 | config-exchange-profiles | done | Per-strategy leverage is nested (`leverage: {s1: 4}`, `z.partialRecord`), not spec's flat `leverage_strategy_1`. `ws_order_adapter` boolean per profile; WS-order guard = `wsOrderAdapter\|\|wsOrderRestFallback` (0300/adapters). No composition root: `load.ts` disk-wrapper unused, no `process.exit` (throws `ConfigParseError` only). Non-Binance WS URLs are placeholders, fix in 0420–0460. `redaction.ts`/`instrument-validation.ts` declared-only (await logger/adapter). |
| 0120 | sizing-precision-denomination | done | Sizing lives in `src/core/sizing/` (not task file's `src/execution/sizing.ts`; core consumers + purity lint block core→execution, user-confirmed) — strategies 0280+ import from here. |
| 0130 | guards-and-opportunity-finder | done | Funding schedule is DERIVED (`Instrument.fundingIntervalHours`+now, UTC math from `markets()`/`normalize()`), no funding feed/port yet — 0210 adds the real feed (also 0290). Threshold direction is an explicit `'negative'\|'positive'` config field (S6's positive `0` threshold makes numeric-sign inference ambiguous) — affects all strategies incl. S6 0350. |
| 0140 | preflight-risk-gate-kill-switch | done | `skip` = no intent row (unknown price, infeasible, non-trading market); `reject` = `ABORTED{errorCode}` WAL-logged (kill switch, risk gate, balance, account setup). Fail-closed: unknown price→skip, unknown balance→reject; engine balance defaults `undefined`, real `main.ts` must fetch it (harness seeds it). `RuntimeStrategyConfig.amountUsd`/`leverage` are flat placeholders; real sizing wiring is 0280. DEFERRED: `max_daily_loss_usd` parsed, NOT enforced (needs realized-P&L, 0390); `breakerOpen` hardcoded `false` until 0380; `accountSetupComplete` defaults `true`, real producer 0240. |
| 0150 | cost-model | done | Covers one canonical exit path per family; S2/S3a sl/deadline paths uncovered (helpers expose them) — 0310/0320. Load-time economic gate (`checkStructuralCostEconomics`) is Group L only (s1/s1-ws/s2); Group S/R/D uneconomic TP configs NOT caught at load (advisory at selection). Cost breakdown is in-memory only (`Engine.costBreakdown`), NOT in WAL — does not survive crash/restart; revisit if 0370/0410 need it persisted. S6 `fundingTerm` is an approximation (PRE-leg amounts are exchange-sourced, not ex-ante derivable) — 0350. |
| 0160 | sim-exchange-fault-injection | done | Sim `validateOrder` applies to limit/stop only; market orders keep un-validated fill + reduce-only cap-to-zero (0060 behavior). Venue-error faults are placeholders exercised via direct `sim.*()` calls, NOT through the engine (`placeOrder` is fire-and-forget); `VenueErrorKind` union + `scriptRateLimit` are stubs, NO token bucket — 0200 adds the real taxonomy + rate limiter + order-FSM raising. `OrderType` widened with `'stop'` (additive scaffolding, no consumer yet — S2/S3a/S4.x). Funding-timeout scenario TODOs tagged for 0320 (S3a)/0350 (S6). |
| 0170 | replay-and-trace | done | Skeleton composition root is `src/replay/build-skeleton-harness.ts` (+`in-memory-repo.ts`,`logger.ts`), moved out of `test/helpers/` so the CLI never imports test code (old paths are thin re-exports). TOOLING: Node native TS doesn't remap `.js`→`.ts` and can't strip param-properties — node CLI entries need the zero-dep resolve hook (`scripts/register-ts.mjs`) + `--experimental-transform-types` (see `npm run replay`); a real `main.ts` will need this. Replay `order-action` records are diagnostic-only, not diffed (writer supports future venue-call replay). Trace header snapshots interim `RuntimeStrategyConfig`+hash, not full `EffectiveConfig` (no `main.ts`) — revisit at config-loading composition. `src/replay/` is a top-level dir with no spec 08 §7 slot (same layout gap as 0090). |
| 0180 | claude-workflows-and-hooks | done | |
| 0190 | binance-clients-and-markets | done | A5: native lib `binance` (tiagosiebler `USDMClient`) — name matches, no substitution; constructed by factory, UNUSED until 0210. ccxt class is `binanceusdm` (not generic `binance`) so `loadMarkets` = perp universe; `options.fetchCurrencies:false` keeps the public load credential-free (else a signed sapi call — copy to 0420–0460). `1000X` FOLD: ccxt `contractSize`=1, fold multiplier into `contractSize` (`1000PEPE`→1000, matches sim); precisions/min-qty taken from ccxt venue steps as-is. `fundingIntervalHours`: read `market.info.fundingIntervalHours` when present, else default 8, validate ∈{1,2,4,8} — ccxt `loadMarkets` does NOT populate it today so effectively always 8; per-symbol `fundingInfo` cross-check DEFERRED (extra REST, 0210 funding feed). COLLISION: Binance lists both plain + multiplier tickers (real: `CATUSDT`+`1000CATUSDT`) that fold to one canonical name — registry keeps the plainer listing, drops the other (NOT an abort); needs a real disambiguation policy (SUGGESTIONS). Only build-time anomalies abort. `createInstrumentValidationHook(adapter)` = `adapter.init()`; NOT wired (no `main.ts`). New gate `RUN_BINANCE_INTEGRATION=1` (excluded from `verify`). |
| 0200 | error-taxonomy-and-rate-limiter | done | 8 typed classes in `src/adapters/shared/errors.ts` over the core `VenueErrorKind` union (union stays core-visible, classes adapter-local); `retryable` derives from kind (`10` §5 handling col: RateLimited/WsTimeout/NetworkError/VenueUnavailable=true, rest=false). `createConsecutiveFailureCounter` exposes the breaker OBSERVER only (0380 owns the trip); non-infra kinds neither count nor reset. `error-map.ts`: numeric code WINS over ccxt class (so a generic `ExchangeError` w/ -2010 → OrderRejected); class check most-specific-first (`OrderNotFound` before `InvalidOrder`); unknown → NetworkError + `onUnknown(rawCode)`, NEVER a raw throw; idempotent on already-mapped. `rate-limiter.ts`: two buckets one refill, order lane = `reserveFraction` of capacity; order may borrow idle general, general NEVER borrows the reserve; general lane DELAYS via `Clock`, order lane THROWS `RateLimited` (no queue). Clock-injected (virtual-clock testable, no `Date.now`). CONFIG: added `rate_limit_weight_per_minute` to `ExchangeProfileYamlSchema`+`ExchangeProfile`+all 6 yaml rows (Binance 2400=published fapi weight/min; other 5 = 2400 placeholders → 0420–0460). Adapter wiring OPT-IN: `limiter?` dep routes the 3 REST reads (loadMarkets weight 20, funding 1) through the general lane + `mapBinanceError`; absent → passthrough (0190 tests unchanged). Order-lane NOT yet wired into `placeOrder`/`cancelOrder` — 0230 consumes the exposed order lane. Weights are placeholders (real ccxt per-endpoint weights → SUGGESTIONS). `createBinanceRateLimiter(profile,clock)` helper in factory (no `main.ts`, stays injectable). |
| 0210 | binance-public-ws | done | `PublicStream` port EXTENDED: `subscribeTicks`/`unsubscribeTicks` added (sim got no-op impls); `subscribe(symbols)` = predicted-funding universe. Predicted funding = ONE `!markPrice@arr@1s` all-market array stream (not per-symbol), gated to the subscribed universe + registry; ticks = per-symbol `<venuesym lowercase>@aggTrade`. `rate = fundingRate*100` (decimal→signed %), `''`→skip. Adapter deps gained `ws?`/`bus?` — BOTH required to wire the stream; absent → `streams.public.*` throws "public stream requires ws+bus deps" (NOT NotImplemented; 0190/0200 offline tests unaffected). Native lib auto-reconnects; our `src/adapters/shared/reconnect.ts` FSM (`live\|degraded\|repriming`) sits ON TOP — REST fallback poll while down (15s cadence), reprime-before-resume on `reconnected` — REUSE for 0220+every venue. `venueToNormalized` reverse map built alongside registry (O(1) per-msg resolve). REST re-prime + funding fallback poll is per-symbol over the FULL universe (weight-1 each, heavy at scale — bulk `fetchFundingRates` optimization in SUGGESTIONS); ticks (shortlist) cheap. Factory builds `wsPublic = new WebsocketClient({beautify:true})` (credential-free) + `fetchTicker` added to `BinanceMarketClient`. Synthetic inline WS fixtures (capture tool 0250); lib type-guards `isWsFormattedMarkPriceUpdateArray`/`isWsAggTradeFormatted` pinned vs installed `binance@3.6.1`. Non-Binance WS URLs/keys still placeholders (0420–0460). `FundingSettled`/funding-gate = 0290. |
| 0220 | binance-private-ws | todo | |
| 0230 | binance-order-manager | todo | |
| 0240 | account-setup-and-trackers | todo | |
| 0250 | fixture-capture | todo | |
| 0260 | binance-testnet-tier | todo | |
| 0270 | e2e-harness | todo | |
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
