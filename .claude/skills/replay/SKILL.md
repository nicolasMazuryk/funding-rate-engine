---
name: replay
description: >
  Wrap `npm run replay` (task 0170) to debug a recorded trace against the pure core
  with zero live venue — the primary way to reproduce and diagnose a failure without
  credentials. Triggers on "/replay <trace>", "replay this trace", "debug this WAL".
---

`scripts/replay.ts` replays a recorded trace's events through a fresh core and diffs
the resulting transitions against the recording (or an explicit golden). Format:
`docs/trace-format.md`.

## Usage

```
npm run replay -- <trace-file> [--expect <golden-file>] [--json]
npm run replay -- --promote <trace-file> [--name <name>]
```

Always add `--json` when interpreting output programmatically — it emits a structured
result instead of the human-readable summary. Exit code `0` = match, `1` = mismatch or
bad args.

## Interpreting `--json` output

The result carries a `firstDivergence` object on mismatch: `{ index, seq, intentId,
expected, actual }`. Read it as: replaying the trace's own recorded events through a
fresh engine produced a different `transition` at that `seq` than what was recorded —
i.e. the core's behavior changed since the trace was captured. Steps:

1. Look up `intentId` in the trace file at that `seq` to see the surrounding
   `event`/`transition` records.
2. Decide: is `actual` a bug (unintended core behavior change) or is `expected` stale
   (the trace predates an intentional behavior change)?
3. Bug → fix the core, re-run the trace, confirm it now matches.
4. Stale golden → re-capture and bless: `npm run replay -- --promote <trace> --name
   <name>`, then re-run `npm run test` to confirm the new golden passes.

Never bless a divergence you have not attributed to a specific, understood code change.

## Golden traces specifically

`test/golden/**` traces are fixtures — the golden test already routes through this same
`replayTrace` code path (`src/replay/replay-engine.ts`), so a golden test failure and a
manual replay mismatch are the same failure surfaced two ways.
