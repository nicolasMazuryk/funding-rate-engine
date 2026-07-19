---
name: scenario
description: >
  Run one sim-venue fault-injection scenario (`test/scenarios/**`, task 0160) in
  isolation and summarize the result. Triggers on "/scenario <name>", "run the
  partial-fill scenario", "check the rate-limit-429 scenario".
---

Scenario files live in `test/scenarios/*.test.ts`, one per `13_risk_and_failure_modes.md`
§6 failure-catalog row (`partial-fill`, `order-reject`, `ws-disconnect`,
`rate-limit-429`, `duplicate-order-update`, `out-of-order-order-update`,
`limit-never-fills`, `reduce-only-violation`, `venue-unavailable`,
`funding-fee-timing`, `crash-mid-intent`, `determinism`). List them with:

```
ls test/scenarios/*.test.ts
```

## Usage

```
npx vitest run test/scenarios/<name>.test.ts
```

Match `<name>` to the catalog phrase (e.g. `/scenario partial-fill` →
`test/scenarios/partial-fill.test.ts`) — `grep`-ability of the catalog phrase in test
names is the load-bearing convention (`test/CLAUDE.md`).

## Interpreting the result

- **Pass:** the scenario's assertions on the resulting intent/order transitions and
  terminal state held. Nothing further.
- **Fail:** Vitest prints the failing assertion with expected vs. actual — for scenario
  tests this is almost always a transition-sequence or terminal-`exit_reason`/`error_code`
  mismatch. Cross-check against the trace: scenarios built with `runScenario`
  (`test/scenarios/run-scenario.ts`) return the full in-memory trace; add a temporary
  `console.log(stableStringify(trace))` (from `src/replay/stable-stringify.ts`) to
  inspect it, or capture to a file and hand it to the `replay` skill.
- **Determinism:** if `determinism.test.ts` is the one that failed, two fresh runs
  produced different traces — the scenario (or code under test) reads real time/
  randomness instead of `clock.now()`. See `test/CLAUDE.md` "Determinism rule".

Do not add a new fault behavior to the sim (`src/adapters/sim/`) as part of "just
running a scenario" — that is scenario-authoring, a separate task-scoped change.
