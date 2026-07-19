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
| 0190 | binance-clients-and-markets | todo | |
| 0200 | error-taxonomy-and-rate-limiter | todo | |
| 0210 | binance-public-ws | todo | |
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
