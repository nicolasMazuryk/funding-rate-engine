# 0170 — `scripts/replay.ts` + trace-as-artifact standard

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0090
**Spec references:** `0000_agentic-development-environment.md` §6 (Observability the agent can read); `14_persistence_and_recovery.md` §2 (WAL as source of truth)

## Objective
The agent's no-live-venue debugger: `scripts/replay.ts` takes a WAL or trace file, re-runs it through the core, and prints a structured diff against expected — turning any failure trace directly into a regression test. Plus the formalized trace format so logs and golden traces are the **same artifact** from here on.

## Context for the agent
0090 already produces a JSONL trace consumed by the golden test. This task promotes that format to a documented contract and builds the CLI around it. The replay principle: the core is deterministic given `(events, config)` (`12` §0) — so feeding recorded events back through it must reproduce the recorded transitions; any divergence is a found bug or an intentional behavior change.

## Scope
- In scope:
  - Trace format spec (`docs/trace-format.md`, short): record types (event, transition, order action), required fields, stable-ordering rules, versioning field.
  - `scripts/replay.ts` (run via `npm run replay -- <file> [--expect <golden>]`): loads a trace/WAL file, reconstructs the input event stream, re-runs the core on the virtual clock, diffs resulting transitions against the file's recorded transitions (or a separate golden), exits 0 on match / 1 with a readable unified diff on mismatch.
  - Machine-readable output mode (`--json`) so agents can parse results.
  - Refactor 0090's golden test to consume the same replay engine (one code path for "golden test" and "CLI replay").
  - A regression-test helper: `npm run replay -- --promote <trace>` copies a trace into `test/golden/` with a name — documented in `test/CLAUDE.md` if it exists, else in the trace-format doc.
- Out of scope: hooks/skills wrapping this (0180), live log shipping/dashboards (none — out of spec), replaying against Postgres state.

## Implementation notes
Keep replay pure-core only: no Postgres, no sim faults — it re-runs decisions, not I/O. Config for the replayed run comes from a header record in the trace (config hash + effective params snapshot) — add that header to the trace writer now; it also serves `14`'s config-attribution goal. Diffing: compare normalized JSON lines; print first divergence with N lines of context.

## Verification (definition of done)
1. `npm run verify` — green (golden test now routed through the replay engine).
2. `npm run replay -- test/golden/<skeleton>.jsonl` — exits 0.
3. Corrupt one transition in a copy, replay with `--expect` — exits 1 and the diff names the intent id and states involved.
4. `--json` output parses and contains `{match: false, firstDivergence: …}` for the corrupted case.
