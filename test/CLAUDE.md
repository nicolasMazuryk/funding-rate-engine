# CLAUDE.md — `test/` (the test harness)

How this repo tests a pure, event-driven engine against a **misbehaving simulated
venue with zero credentials** (`0000_agentic-development-environment.md` §5; `17`).
The load-bearing property is determinism: same inputs → same trace, every run.

## Tiers

| Tier | Path | Needs | In default `npm run test`? |
|---|---|---|---|
| Unit | `test/unit/**` | nothing (no I/O) | yes |
| Scenario | `test/scenarios/**` | sim venue + virtual clock + engine (still no real I/O) | yes |
| Golden | `test/golden/**` | byte-compared fixtures | yes |
| Integration | `test/integration/**` | Postgres (separate script) | no — excluded from default verify |
| Testnet | `src/testnet/`, run via `npm run test:testnet` | venue testnet creds (skips clean without) | no — excluded from default verify |
| E2E | `test/e2e/**` | sim venue + virtual clock + real Docker Postgres + real local WAL | no — `npm run test:e2e`, opt-in |

`npm run verify` (typecheck + `biome check` + `vitest run`) is the gate; it runs the
unit/scenario/golden tiers. Integration/e2e are opt-in and must never be wired into the
default run.

## E2E conventions (`test/e2e/`)

- **Reuse `harness.ts`, don't re-wire.** `createE2eContext()` migrates + owns the admin
  pool; `reset()` truncates the two tables and makes a fresh tmp WAL per test;
  `bootInstance()` composes `buildSkeletonEngine` + real `createPgRepo` + `createForwarder`
  and returns the DB/local-WAL accessors. Assertion helpers live in `assertions.ts`
  (`expectTerminal`, `checkWalDbConsistency`, `expectTradeRecordShape`).
- **One scenario file per strategy** from 0280 (`s1.e2e.test.ts`, …), each plugging its
  own strategy + exit-policy registry into `bootInstance`. `skeleton.e2e.test.ts` is the
  stub-strategy proving tier.
- Needs Docker Postgres (`docker compose up -d`); never part of `npm run verify`.

## Scenario conventions (`test/scenarios/`)

- **One scenario = one file**, named to match a `13_risk_and_failure_modes.md` §6
  failure-catalog row (`partial-fill`, `order-reject`, `ws-disconnect`, `rate-limit-429`,
  …). The test name should contain the catalog phrase so `grep` over test names maps
  coverage to the catalog.
- Build declarative scenarios with `scenario(name).at(ts, action)` (`dsl.ts`) and run
  them via `runScenario` (`run-scenario.ts`), which wires a full `SkeletonHarness`,
  advances the virtual clock to each step, and returns the in-memory trace. For scenarios
  that drive the venue directly (resting orders, venue-error faults — see the plan §3
  ASSUMPTION on why these bypass the fire-and-forget engine), use `simHarness()`
  (`sim-harness.ts`).
- **Reuse, don't re-derive harness wiring.** Skeleton composition lives in
  `helpers/build-skeleton-engine.ts`; the crash/restart sequence in
  `scenarios/crash-helper.ts`; the shared triggered-intent timeline in
  `helpers/skeleton-scenario.ts`.
- Faults are **opt-in per scenario** — the sim's happy path (0060) is unchanged, so a
  scenario that scripts no fault behaves exactly like a live-venue happy path.

## Trace fixtures (`test/golden/`)

- **One unified trace file per golden run** — header + `event`s + `transition`s in
  one JSONL artifact (`skeleton.trace.golden.jsonl`), not separate WAL/event files.
  Format is documented in `docs/trace-format.md`; it is written by the harness when
  `buildSkeletonEngine({ tracePath })` is set.
- The golden test routes the captured trace through the shared `replayTrace`
  (`src/replay/replay-engine.ts`) — the *same* code path `scripts/replay.ts` runs,
  so a golden drift and a replay divergence are one failure.
- Bless a captured trace as a fixture with `npm run replay -- --promote <trace>
  [--name <name>]`.

## Determinism rule (load-bearing)

- **Virtual clock only.** No `setTimeout`, no real waits, no `Date.now()` anywhere under
  `test/**`. Time advances solely via `VirtualClock.advanceTo/advanceBy`, and every
  sim/scheduler side effect resolves synchronously inside that advance.
- **Every fault keys off `clock.now()` or an event ordinal — never randomness.** Drop /
  duplicate / delay / reorder and per-call venue errors are all deterministic functions
  of the virtual clock and emit order.
- **Two runs from fresh state must be byte-identical** (`determinism.test.ts` asserts
  this via `stableStringify`). A test that is not reproducible is a bug in the test.

## Out of scope here

This file does not restate the core-purity rule (`src/core/CLAUDE.md`),
WAL-before-side-effect (`docs/architecture.md`), or `npm run verify` mechanics (root
`CLAUDE.md`) — see those.
