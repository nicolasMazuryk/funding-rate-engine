# ROADMAP — Funding-Rate Trading Engine Implementation Plan

**Scope:** end-to-end implementation of the system specified in `docs/specs/` (specs `0000`, `00`–`17`), broken into 53 tasks, each completable and mechanically verifiable by a fresh Claude Code agent in a single context window (<80k tokens).

**How to use this file:** read the phase overview and the task you were assigned, then follow `docs/plan/EXECUTION.md`. Task files live in `docs/plan/tasks/NNNN_*.md`. Status lives in `docs/plan/STATUS.md` (never edit EXECUTION.md to track status). The spec coverage matrix (spec section → implementing task, plus the deferral ledger) lives in `docs/plan/COVERAGE.md`.

---

## 1. Phase overview

| Phase | Theme | Tasks | Outcome |
|---|---|---|---|
| **0 — Foundation** | Minimal agent-loop subset of spec 0000: scaffold, strict TS, lint/format, Vitest smoke test, `npm run verify`, CLAUDE.md + `.claude/` | 0010–0020 | Agent can write → verify → fix locally. No CI (deferred, see §3). |
| **1 — Walking skeleton** | Spec 0000 §8 vertical slice: events, ports, FSM engine, virtual clock, minimal fake venue, local WAL, minimal Postgres, golden replay + crash-recovery test | 0030–0090 | Thinnest end-to-end path green: Timer → intent → fake fill → CLOSED → WAL → Postgres. |
| **2 — Core deepening + simulation** | Config system (09), sizing/precision, guards, preflight/risk/kill switch, cost model, fault-injecting sim venue + scenario files, replay tooling, Claude workflows | 0100–0180 | Full pure core testable against a misbehaving simulated venue with zero credentials. |
| **3 — Binance adapter (deep)** | First real venue, built as the reference pattern: clients, markets, errors, rate limiter, public/private WS, order manager, trackers, fixtures, testnet tier | 0190–0260 | Binance adapter passes integration + testnet suites. |
| **4 — Strategies** | S1 → S1-WS → S2 → S3a → S4.1a → S4.2a → S6, each with its exit-policy kind, sim scenarios, e2e coverage | 0270–0350 | All 7 strategies verified against the sim harness end-to-end. |
| **5 — Sidecars full** | Full Postgres schema, complete crash recovery, circuit breakers/flatten/orphans, accounting, reconciliation, analytics | 0360–0410 | Specs 13/14/15 fully implemented. |
| **6 — Remaining venues** | Bybit, OKX, Bitget, KuCoin — one pattern-following task per venue (Gate.io / 0450 skipped by decision) | 0420–0460 | All five adapters behind the one interface; testnet tiers where available. |
| **7 — Live tier** | Capped real-money harness, live verification runs, S6 shadow → canary | 0470–0500 | Layered verification complete through real production runs (spec 0000 "stakes"). |
| **8 — Fleet** | Docker image, 30-instance compose fleet, config generation, deferred CI task | 0510–0530 | Deployable 5×6 fleet; CI mirrors local verify. |

**Spec-0000 interleaving (auditable):** every 0000 item is tagged either *foundation* or *JIT* in the coverage matrix (`docs/plan/COVERAGE.md`, row `0000`). Foundation: scaffold/tooling/verify (0010), root CLAUDE.md + settings + architecture/agent-workflow docs (0020). JIT: core CLAUDE.md with the ports task (0030), test CLAUDE.md with the sim harness (0160), adapters CLAUDE.md with the first adapter (0190), hooks/skills/commands + testing-strategy doc before the adapter/strategy grind (0180), replay/trace tooling after the skeleton proves the trace format (0170), fixture capture with the first real venue (0250), testnet tier command (0260), e2e harness immediately before the first strategy (0270), live tier when strategies + risk exist (0470), CI deferred to 0530.

---

## 2. Milestones (what "working" means at each point)

1. **After 0090:** `npm run verify` green including a golden replay test and crash-recovery test of the full skeleton slice. This is spec 0000 §8's proof-the-machine-works.
2. **After 0180:** an agent can develop any core feature with zero credentials against a misbehaving sim venue, with replay-based debugging and hooks enforcing checks.
3. **After 0260:** the Binance adapter is proven against recorded fixtures and live testnet.
4. **After 0350:** all seven strategies pass unit + sim-scenario + e2e suites.
5. **After 0410:** every trade produces a reconciled, decomposed P&L record; crash recovery covers every WAL state.
6. **After 0460:** five venues behind one interface (Gate.io dropped — see STATUS 0450).
7. **After 0500:** live capped-money verification done; S6 shadow/canary metrics collected and machine-checked.
8. **After 0520:** the 30-instance fleet is deployable from one image.

---

## 3. Binding decisions & assumptions

Decisions made during planning (from the planning interview, binding on all tasks):

1. **First venue: Binance** — deep, multi-task adapter build; remaining 5 venues are one pattern-following task each.
2. **Strategy order:** S1 → S1-WS → S2 → S3a → S4.1a → S4.2a → S6 (simplest-first; S6 last — shadow/canary protocol, most complex entry FSM). *Assumption, recorded.*
3. **Live real-money tier is a normal task tier** — the agent runs it itself (keys will exist), hard-capped notional, auto-flatten, machine-checkable pass/fail.
4. **CI deferred** to Phase 8 (task 0530). Deliberate deviation from spec 0000 "basic CI in Phase 0".
5. **Docker available locally** — Postgres for integration tests runs via `docker compose`.
6. **Testnet tier included** where the venue has a usable testnet (Binance: yes; per-venue availability is determined inside each venue task and recorded there).
7. **Legacy code refs in specs** (`src/execution/...` paths) are **noise**, not layout mandates — the layout in spec 08 §7 governs.
8. **Status ledger** is `docs/plan/STATUS.md`; `EXECUTION.md` is a static SOP.

Open questions found in the specs, each resolved with a recorded assumption (do not re-litigate; if a spec contradiction matters at implementation time, follow the assumption here and note it in STATUS.md):

| # | Question / ambiguity | Assumption chosen |
|---|---|---|
| A1 | Funding-fee event matching tolerance: `00_globals` §6 and `02` §3 say **±5 s**; `11` §7 says **±30 s**. | ±5 s is normative (globals + strategy file agree; strategy files are source of truth for strategy behavior). Implement as a named constant; note the `11` §7 discrepancy in code comment. Task 0290. |
| A2 | Linter/formatter not named by specs (only "formatter/linter/typechecker"). | **Superseded 2026-07-18 (user decision, task 0010 revision):** Biome (`biome check`) — one tool for lint + format — replaces the earlier ESLint (typescript-eslint, strict) + Prettier lock. The purity-boundary import-restriction mechanism is decided and lands in **task 0030** (no longer tied to `eslint-plugin`). Task 0010/0030. |
| A3 | Risk defaults differ: `09` §3 example shows `max_concurrent_intents: 1`, `max_notional_usd: 20`; `13` §1 table says 10 / 100. | `13` §1 is the schema-default registry; `09` §3 is an example instance file with tighter values. Schema defaults from 13; per-instance YAML may tighten. Task 0140. |
| A4 | Scenario file format: spec 0000 §5 says "YAML or TS". | TypeScript scenario files (typed, refactor-safe, no extra parser). Task 0160. |
| A5 | Native npm lib names (`kucoin-api`, …) may not exist under exactly those names. | Use the canonical list from `08` §6 where published; if an exact name is unavailable, substitute the maintained equivalent for that venue and record the substitution in STATUS.md notes. Tasks 0190, 0420–0460. |
| A6 | Proposed vs schema-default parameter values differ (e.g. S1 `amountUsd` proposed 10, schema default 20). | Canonical schema ships **schema defaults** (per `00` §8.2); committed example configs ship **proposed values** (per strategy file §5 tables). Task 0100. |
| A7 | Spec 08 §7 layout shows `persistence/` outside `src/` indentation ambiguity. | All source under `src/` (`src/persistence/`, `src/execution/`, etc.) — consistent with the tree's intent. Task 0010. |
| A8 | "Basic CI" required by 0000 in Phase 0. | Deferred (decision 4). Recorded here and in `docs/plan/COVERAGE.md`. |
| A9 | S6 canary/shadow require weeks of wall-clock time. | Tasks 0490/0500 deliver the tooling, machine-checkable metrics, and runbooks, plus a bounded smoke run. The multi-week observation window itself is an operational activity outside task scope; acceptance thresholds are encoded and checkable at any time. |
| A10 | Live verification (0480) needs real API keys and money. | Task assumes keys exist in `.env` per `09` §2 (interview decision); the harness enforces hard caps and auto-flatten; if keys are absent the task's verification steps fail loudly and the task cannot be marked done. |
