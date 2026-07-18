# COVERAGE — Spec Coverage Matrix

Every spec file and its major sections mapped to implementing task(s). **F** = foundation, **JIT** = just-in-time slot (spec 0000 rows only). Nothing is silently dropped; deferrals are explicit. Reverse lookup: use this file to answer "which task implements spec section X"; each task file's **Spec references** line gives the forward direction.

Companion docs: `docs/plan/ROADMAP.md` (phases, decisions, assumptions), `docs/plan/EXECUTION.md` (agent SOP), `docs/plan/STATUS.md` (ledger).

| Spec | Section | Task(s) |
|---|---|---|
| **0000_agentic-development-environment** | §1 Repo scaffolding & tooling | 0010 (F) |
| | §2 Agent context: root CLAUDE.md, `.claude/settings.json` | 0020 (F) |
| | §2 Nested CLAUDE.md — `src/core/` | 0030 (JIT, with ports) |
| | §2 Nested CLAUDE.md — `test/` | 0160 (JIT, with sim harness) |
| | §2 Nested CLAUDE.md — `src/adapters/` | 0190 (JIT, with first adapter) |
| | §2 Hooks, skills, slash commands, subagents | 0180 (JIT, before adapter/strategy grind) |
| | §3 Verification loop — `npm run verify` | 0010 (F); tier commands: 0260 (testnet), 0270 (e2e), 0470 (live) |
| | §3 CI gates | **Deferred** to 0530 (Phase 8) — deliberate deviation; local `npm run verify` is the gate until then |
| | §5 Sim exchange + virtual clock | 0050 + 0060 (skeleton), 0160 (full fault injection, JIT) |
| | §5 Scenario files from failure catalog | 0160 |
| | §5 Fixture capture tooling | 0250 (JIT, with Binance) |
| | §6 Observability: trace = replay artifact, `scripts/replay.ts` | 0090 (minimal trace), 0170 (JIT) |
| | §7 docs/architecture.md, agent-workflow.md | 0020 (F) |
| | §7 docs/testing-strategy.md | 0180 (JIT) |
| | §8 Vertical slice | 0090 |
| | Stakes: layered live verification, capped real-money tier | 0470, 0480, 0500 |
| **00_globals** | §1 notation, units | 0030 (types), 0100 (unit guards) |
| | §2–§3 timeline, accrual/rate/FIFO rules | 0290 (T_drop/gate), 0390 (accrual booking), strategy tasks 0280–0350 |
| | §4 sizing & account plumbing | 0120, 0240 |
| | §5 safety: kill switch, sweep, orphans | 0140 (kill switch), 0330/0340 note, 0380 (sweep + orphans full) |
| | §6 order path & per-exchange deltas | 0110 (deltas), 0230 (stagger, fallback, polls), 0290 (funding-fee poll) |
| | §7 engine guards | 0130 |
| | §8 variable/parameter registry | 0100 (schema), 0390 (output vars §8.3) |
| | §9 bounds & unit-mismatch protection | 0100; round-trip test 0100 (local), 0530 (in CI) |
| | §10 exit_reason / error_code registries | 0040 (enums in FSM tables), per-strategy tasks, 0390 |
| | §G-L / §G-S / §G-R / §G-D group logic | 0280/0300/0310 (G-L), 0320 (G-S), 0330/0340 (G-R), 0350 (G-D) |
| | §11 reconciliation index R1–R12 | folded into the owning tasks (R2/R10→0280; R4→0100; R5→0340; R6→0100; R7→0330/0340/0390; R8→0310; R11→0330/0340; R12→0040) |
| **01_strategy_1** | all §1–§5 | 0280 |
| **02_strategy_1_ws** | all §1–§5 | 0300 (gate mechanics in 0290) |
| **03_strategy_2** | all §1–§5 | 0310 (tracker recovery also 0370) |
| **04_strategy_3a** | all §1–§5 | 0320 (co-run guard in 0110) |
| **05_strategy_4_1a** | all §1–§5 | 0330 (ladder split math in 0120) |
| **06_strategy_4_2a** | all §1–§5 | 0340 |
| **07_strategy_6** | §1–§5 entry FSM, exits, params | 0350 |
| | §6 shadow → canary protocol | 0490, 0500 |
| **08_system_overview** | §2 principles, §3 layers, §7 layout | 0010 (layout), 0030 (ports/purity), enforced from 0030 on |
| | §4 event stream | 0030 |
| | §5 design patterns (FSM, registry, repo, factory…) | 0040 (FSM), 0130 (registry), 0080/0360 (repo), 0190 (factory), 0200 (breaker util used by 0380) |
| | §6 tech stack & libraries | 0010, 0190 |
| | §8 end-to-end flow | 0090 (skeleton), 0270+ (real flow) |
| **09_configuration** | §1–§3 sources, .env, strategy YAML | 0100 |
| | §4 exchange profiles + deltas | 0110 |
| | §5–§6 pipeline, cross-checks | 0110 |
| | §7 change management, config hash | 0110 (hash), 0370 (hash check on recovery), 0520 (fleet configs) |
| | §8 single-schema guarantee | 0100 |
| **10_exchange_adapters_and_market_data** | §2 adapter interface | 0030 (port), 0190 (impl) |
| | §3 market load & filter | 0190 |
| | §4 normalization, precision, denomination | 0120 (math), 0190 (registry) |
| | §5 error taxonomy | 0200 |
| | §6 rate limiter | 0200 |
| | §7 public WS | 0210 |
| | §8 funding-rate data | 0210 (predicted), 0290 (settled/gate), 0400 (history reconcile) |
| | §9 purity notes | 0030 (lint enforcement) |
| | per-venue | 0420–0460 |
| **11_execution_and_account_state** | §1 account setup | 0240 |
| | §2–§3 sizing, precision enforcement | 0120, 0230 |
| | §4 idempotency clientOrderId | 0230 |
| | §5 WS-first/REST-fallback order path | 0230 |
| | §6 order FSM | 0040 (engine+table), 0230 (wiring) |
| | §7 private WS streams | 0220 |
| | §8 position tracking | 0240 |
| | §9 funding-fee tracking | 0240, 0290 |
| **12_strategy_runtime_and_intent_lifecycle** | §1 scheduler | 0050 (skeleton), 0130 (full scan workflow) |
| | §2 opportunity finding | 0130 |
| | §3 preflight | 0140 |
| | §4 cost model | 0150 |
| | §5 intent FSM | 0040 (table), 0090 (skeleton), exit-policy kinds in 0280–0350 |
| | §6 monitoring→exit orchestration | 0280–0350 |
| | §7 purity & reuse | 0030 |
| **13_risk_and_failure_modes** | §1 risk gate | 0140 |
| | §2 kill switch | 0140 (states + preflight reject), 0380 (persistence + escalation + flatten trigger) |
| | §3 circuit breakers | 0380 |
| | §4 flatten | 0380 |
| | §5 orphan & desync | 0380 (orphan flatten, stale sweep), 0240 (detection hook) |
| | §6 failure catalog | 0160 (as executable scenarios), individual handling in owning tasks |
| **14_persistence_and_recovery** | §1 what survives | 0070, 0360 |
| | §2 WAL + §2.1 two-tier write path | 0070 (local), 0080 (forwarder minimal), 0370 (forwarder robustness) |
| | §3 schema | 0080 (minimal), 0360 (full) |
| | §4 idempotency at store | 0360 |
| | §5 crash recovery | 0090 (two-state test), 0370 (full sequence, every WAL state) |
| | §6 backup & durability | 0360 (synchronous_commit), 0520 (ops runbook) |
| **15_accounting_and_reconciliation** | §1 post-trade accounting | 0390 |
| | §2 reconciliation | 0400 |
| | §3 P&L attribution | 0390 (S6 attribution audited in 0500) |
| | §4 trade analytics | 0410 |
| | §5 fleet rollup | 0410 |
| **16_fleet_deployment** | §1–§2 instance model, 5×6 fleet | 0510, 0520 |
| | §3 Docker packaging | 0510 |
| | §4 operating the fleet | 0520 |
| **17_testing** | §1–§2 unit layer | 0010 (runner), enforced per task throughout |
| | §3 integration per exchange | 0260, 0420–0460 |
| | §4 e2e | 0270, 0370 (crash e2e), strategy tasks |
| | §5 S6 shadow/canary | 0490, 0500 |
| | §6 CI | **Deferred** to 0530; round-trip test runs locally from 0100 |

**Deferred / out of scope (complete list):**
- **CI** (spec 0000 §3 "basic CI", spec 17 §6): deferred to task 0530 in Phase 8 by explicit decision. Until then `npm run verify` locally is the gate. Task 0530 flips the two Deferred rows above when it lands. Nothing else is deferred.
