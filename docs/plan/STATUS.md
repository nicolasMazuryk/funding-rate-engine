# STATUS — Task Ledger

One row per task. Agents update this file only (see `docs/plan/EXECUTION.md`). Statuses: `todo` | `in_progress` | `done` | `blocked`. Keep notes terse — a few short clauses, not prose; this file is re-read every session, so detail belongs in the commit/PR, not here.

| ID | Task | Status | Notes |
|---|---|---|---|
| 0010 | repo-scaffold-and-verify | done | Layout `src/persistence/` (not spec 08 §7) per user. Biome supersedes ESLint+Prettier (ROADMAP §3 A2). Added `.nvmrc` (Node 24.18.0), `npm start`; deps bumped latest. No product deps. Purity rule → 0030. |
| 0020 | agent-context-layer | done | Added root `CLAUDE.md`, `docs/architecture.md`, `docs/agent-workflow.md` (documents existing scripts only). Nested CLAUDE.md/hooks/skills/`testing-strategy.md` deferred (0030/0160/0180/0190). Trimmed 0010's dup Biome note per user. |
| 0030 | core-events-and-ports | done | 8 event types + `EngineEvent` union; sync per-symbol-FIFO bus; ports (`ExchangeAdapter`, `Clock`, `Repo`, `RiskGate`, `EventBus`); `src/core/CLAUDE.md`. Purity via Biome `noRestrictedImports` on `src/core/**` (ROADMAP §3 A2). Verify said `npm run lint` (absent) → used `npm run check`. `Repo`/`RiskGate` intent types are placeholders for 0040. Imports use `.js` specifiers. |
| 0040 | fsm-engine | done | Generic `defineMachine` engine + intent FSM (`src/core/intent/`) + order FSM (`src/execution/order-machine.ts`). Illegal transitions: compile error on literal `from`, runtime `IllegalTransitionError` otherwise. `transitionIntent` enforces R12 (`→CLOSED` needs `exitReason`; `→ABORTED/ENTRY_FAILED/NO_POSITION` needs `errorCode`). `onTransition` = WAL gate for 0070. ASSUMPTION: `NO_POSITION` reachable from `SUBMITTING_ENTRY` + `MONITORING` (not `MONITORING`-only per 12 §5 diagram) — flagged for review. Tests flat under `test/unit/`. |
| 0050 | clock-and-scheduler | done | `Clock` impls (`real-clock.ts`, `virtual-clock.ts`); pure `Scheduler` (`start`/`stop`/`scheduleEntryTimer`/`scheduleDeadlineTimer`, publishes `Timer{kind}`). Scan boundary `HH:58:00` self-perpetuates via `nextScanBoundary` + `<=` guard. Tests mirrored (`test/unit/core/`, `test/unit/adapters/clock/`). Determinism verified. |
| 0060 | fake-adapter-minimal | done | `src/adapters/sim/sim-exchange.ts` (`createSimExchange(clock, bus)`). 3 hardcoded instruments (BTC/ETH contractSize 1; PEPE `1000PEPEUSDT` contractSize 1000). MARKET fills instantly at scripted mark → `OrderUpdate(FILLED)`+`PositionUpdate`; one-way position math. DECISION: funding sign `signedFundingPct = long ? -rate : rate` (00_globals §1.1/§3.1) — flagged. DECISION: `BalanceUpdate` on funding accrual only. Reduce-only caps close qty; LIMIT out of scope → REJECTED. Fail-loud on unknown symbol/unscripted price/rate/order id. `satisfies ExchangeAdapter`. Scripting surface (`setPrice`/`setPredictedFunding`/`settleFunding`) sharpen → 0160. |
| 0070 | local-wal | done | `TransitionLog` port + `src/persistence/wal/wal-file.ts`: JSONL append-only, `fsyncSync` per append (durable before promise resolves), monotonic `seq` across reopen, `readAll` tolerates torn final line but throws on corrupt non-final. DECISION: `transitionIntent` unchanged (no `intentId` param yet); per-intent wiring → 0090+. Follow-up: deleted unused `Repo.appendIntentTransition` placeholder; swept 0030 task `npm run lint`→`npm run check`. |
| 0080 | postgres-drizzle-minimal | done | Drizzle+pg; `intents`+`intent_wal` (nat key `intent_id,from_state,to_state`); `createPgRepo`/`createForwarder` scoped by instance triple. Dev triple hardcoded (`DEV_INSTANCE`, sim/s1/dev) until 0110. Watermark re-derived from `MAX(seq)` (no sidecar). `Repo` port grew `upsertIntentState` + `IntentSnapshot` optional fields — treat as current surface, not final. `TERMINAL_INTENT_STATES` exported from intent-machine. Files under `src/persistence/db/` (task file said `src/persistence/repo.ts`; kept db code together). Integration suite split out of `verify`; needs `docker compose up`. Outage test simulates unreachable DB via ended pool. |
| 0090 | walking-skeleton-slice | todo | |
| 0100 | config-canonical-schema | todo | |
| 0110 | config-exchange-profiles | todo | |
| 0120 | sizing-precision-denomination | todo | |
| 0130 | guards-and-opportunity-finder | todo | |
| 0140 | preflight-risk-gate-kill-switch | todo | |
| 0150 | cost-model | todo | |
| 0160 | sim-exchange-fault-injection | todo | |
| 0170 | replay-and-trace | todo | |
| 0180 | claude-workflows-and-hooks | todo | |
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
