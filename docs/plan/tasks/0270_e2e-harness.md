# 0270 — End-to-end harness

**Phase:** 4 — Strategies
**Depends on:** 0140, 0150, 0160, 0170
**Spec references:** `17_testing.md` §4 (end-to-end tests); `0000_agentic-development-environment.md` §3 (per-tier commands); `12_strategy_runtime_and_intent_lifecycle.md` §5 (exit-policy dispatch)

## Objective
The full-instance e2e tier, arriving just-in-time before the first real strategy: drive a complete instance — scheduler → finder → preflight → intent → execution → persistence — with the fault-injecting sim venue, real Postgres, and a real local WAL file, organized so each strategy task can add its scenarios as data. Includes the exit-policy dispatch mechanism the strategy tasks plug into.

## Context for the agent
`17` §4 defines the tier: sim venue + real (centralized) Postgres + real WAL file. The harness composes the real engine wiring (as `main.ts` will — 0280 finishes the composition root; here build the test-facing composer). Exit-policy dispatch (`12` §5): `MONITORING` behavior delegates to a handler per exit-policy *kind* selected by registry — define the `ExitPolicyHandler` interface (consumes `MarketTick`/`FundingFeeAccrued`/`Timer`, commands exits) with **no** kinds implemented yet (each strategy task brings its kind; the 0090 stub's inline timed exit gets refactored to be the placeholder).

## Scope
- In scope:
  - `test/e2e/harness.ts`: boots a full instance from an `EffectiveConfig` + scenario (0160 DSL), on virtual clock + sim venue + docker Postgres + temp WAL dir; returns trace + DB state accessors for assertions.
  - `ExitPolicyHandler` interface + registry in `src/core/intent/exit-policy.ts`; `MONITORING` dispatch wired in the engine.
  - Assertion helpers: expected intent terminal state, `exit_reason`/`error_code`, WAL/DB consistency (every WAL transition present in `intent_wal`), trade-record shape.
  - `npm run test:e2e` command; two proving e2e tests using the stub strategy: happy path and kill-switch-paused path (from 0140's checklist, now at full-instance level).
  - Fold into `docs/testing-strategy.md` (tier now exists — update the doc from 0180).
- Out of scope: any real exit-policy kind (0280+), strategy scenarios (their tasks), crash-recovery e2e matrix (0370).

## Implementation notes
Reuse 0080's docker Postgres and truncate per test; isolate WAL files per test in tmp dirs. Keep harness boot < ~1 s so per-strategy suites stay fast. The harness is the composition root's twin — extract shared wiring into `src/composition.ts` so `main.ts` (0280) and the harness cannot drift.

## Verification (definition of done)
1. `npm run verify` — green; `npm run test:e2e` (docker up) — both proving tests pass.
2. WAL↔DB consistency helper demonstrated: deliberately skip the forwarder in one test → assertion fails as designed (then re-enable).
3. Exit-policy dispatch: stub strategy resolves its handler via the registry (no `instanceof`/name branching — grep the engine for strategy names returns nothing).
