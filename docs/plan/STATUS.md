# STATUS — Task Ledger

One row per task. Agents update this file only (see `docs/plan/EXECUTION.md`). Statuses: `todo` | `in_progress` | `done` | `blocked`.

| ID | Task | Status | Notes |
|---|---|---|---|
| 0010 | repo-scaffold-and-verify | done | 2026-07-18: layout uses `src/persistence/` (task file) not spec 08 §7 `src/adapters/persistence/`, per user decision. Purity-boundary rule deferred to 0030. No product deps installed. 2026-07-18 (revision): Biome supersession of ESLint+Prettier recorded in ROADMAP §3 A2 (single source of truth); added `.nvmrc` (Node 24.18.0 LTS) and `npm start`; bumped typescript/vitest/@biomejs/biome to latest. |
| 0020 | agent-context-layer | done | 2026-07-18: added root `CLAUDE.md`, `docs/architecture.md`, `docs/agent-workflow.md`. CLAUDE.md documents only existing package.json scripts. Nested CLAUDE.md files + hooks/skills + `docs/testing-strategy.md` deferred (0030/0160/0180/0190). Recorded Biome supersession in ROADMAP §3 A2 (single source of truth) and trimmed the duplicate note from 0010 above — plan-doc edit beyond STATUS-only convention, per explicit user interview decision. |
| 0030 | core-events-and-ports | done | 2026-07-19: 8 event types + `EngineEvent` union, sync per-symbol-FIFO bus (queue-drain, FIFO under re-entrant publish), 4 ports (`ExchangeAdapter`+value types, `Clock`, `Repo`, `RiskGate`) + `EventBus` port, `StrategyId` placeholder, `src/core/CLAUDE.md`. Purity enforced via **Biome `noRestrictedImports` override** on `src/core/**` (not ESLint — ROADMAP §3 A2), `paths` (ccxt/pg/drizzle-orm/ws/pino/fs/net/http +`node:` forms) + `patterns` (adapters/persistence/execution). Verify step 2 says `npm run lint` (no such script) → used **`npm run check`**; scratch-import test fired both rules, exit 1. `Repo`/`RiskGate` intent types (`IntentId`/`IntentState`/`RiskIntent`) are **deliberate minimal placeholders** for 0040 to sharpen. Imports use `.js` specifiers (local dialect; `allowImportingTsExtensions` unset). Removed now-populated `.gitkeep`s (events/ports/strategies). |
| 0040 | fsm-engine | done | 2026-07-19: one generic `defineMachine` engine (`src/core/intent/fsm-engine.ts`, ~95 lines) + two tables: intent FSM (`src/core/intent/intent-machine.ts`) and order FSM (`src/execution/order-machine.ts`). Engine types `to` as `T[From][number]` → `SELECTED→CLOSED` is a **compile error** where `from` is literal (terminal entry = `[]` = `never`); runtime `IllegalTransitionError` (carries from/to/machine) backstops dynamic calls. `onTransition` observer = the WAL gating point for 0070. `transitionIntent` wrapper enforces R12: `→CLOSED` needs `exitReason` only, `→ABORTED/ENTRY_FAILED/NO_POSITION` needs `errorCode` only (throws otherwise). All 7 `exit_reason` + 10 `error_code` values modeled as closed unions, each producible-by-legal-path in a named test. **ASSUMPTION (dual-source `NO_POSITION`):** made reachable from BOTH `SUBMITTING_ENTRY` and `MONITORING`, not `MONITORING`-only as the `12` §5 ASCII diagram draws it — spec prose supports it (`limit_expired`/`ladder_no_fills` are `SUBMITTING_ENTRY` outcomes; S6 sub-machine spans both entry phases). Flagged for human review. Test paths are flat (`test/unit/*.test.ts`) per the task's literal verify command, diverging from 0030's mirrored `test/unit/core/...`. `npm install` was needed (no `node_modules` on arrival) — dev deps only, product deps still absent. Order/intent placeholder types in `ports/repo.ts`/`risk-gate.ts` left as-is (`IntentState=string` is a valid supertype; narrowing them would ripple, deferred). |
| 0050 | clock-and-scheduler | done | 2026-07-19: `Clock` impls — `real-clock.ts` (Date.now + setTimeout/clearTimeout) and `virtual-clock.ts` (manual `advanceTo`/`advanceBy`, fires due timers in `(atMs, seq)` order, monotonic `now`, past-due timers fire without rewind, cancelled=`done` flag, idempotent cancel). `core/runtime/scheduler.ts` (pure, ports-only): `start`/`stop`/`scheduleEntryTimer`/`scheduleDeadlineTimer`, publishes `Timer{kind}`; scan boundary `HH:58:00` self-perpetuates (reschedules from fired boundary via `nextScanBoundary`, `<=` guard prevents same-instant re-fire); no `T_settle`/offset math — callers pass `atMs` (`12` §1, `00_globals` §8.1). Tests mirror `test/unit/core/...` + `test/unit/adapters/clock/...` (0030 layout, NOT 0040's flat) — divergence intentional, task verify text pins no path. Determinism confirmed (suite run twice, identical). `grep setTimeout test/` = none. `npm install` needed again (no node_modules on arrival; dev deps only). |
| 0060 | fake-adapter-minimal | todo | |
| 0070 | local-wal | todo | |
| 0080 | postgres-drizzle-minimal | todo | |
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
