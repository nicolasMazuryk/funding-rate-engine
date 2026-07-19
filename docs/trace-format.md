# Trace format (`v1`)

The trace is **one JSONL artifact that is both the operational log and the golden
test fixture** — same bytes, one source of truth. Task 0170 introduced it,
replacing task 0090's two separate streams (a WAL trace + an events trace). One
file means a single monotonic `seq` can capture the *true interleaving* of bus
events, WAL transitions, and (future) order actions in observed order — the
load-bearing reason for one file, not two.

Written by `src/replay/trace-file.ts`, read back by the same module and replayed
by `src/replay/replay-engine.ts`. Every line is serialized with `stableStringify`
(recursively sorted keys), so the artifact is byte-stable regardless of the order
fields were constructed in — a prerequisite for byte-compared golden fixtures.

## Record kinds

One record per line. The `header` is always the first line and the only record
without a `seq`; every other kind shares one monotonic `seq` counter.

| `kind` | Role | Diffed by replay? | Fields (beyond `v`, `kind`) |
|---|---|---|---|
| `header` | Config snapshot | — | `ts`, `configHash`, `strategyConfig` |
| `event` | Replay **input** — a bus event exactly as published | as input | `seq`, `ts`, `event` (an `EngineEvent`) |
| `transition` | Recorded **output** — a WAL transition | **yes** | `seq`, `ts`, `intentId`, `fromState`, `toState`, `payload`, `clientOrderId?` |
| `order-action` | Venue submit/cancel — **diagnostic only** | no | `seq`, `ts`, `action` (`place`\|`cancel`), `clientOrderId`, `symbol`, `side`, `qty`, `reduceOnly?` |

## Input / output contract

- **`event` = input.** Replay publishes these, in `seq` order, through a fresh pure
  core. To keep recorded events the *sole* driver, the replay harness swaps in an
  inert scheduler (engine timer-scheduling is a no-op, so recorded `Timer`s are the
  only timers) and an order-suppressing sim (`placeOrder`/`cancelOrder` emit
  nothing, so recorded `OrderUpdate`/`PositionUpdate` are the only fills).
- **`transition` = output, diffed.** Replay compares the fresh run's WAL
  transitions against the recorded ones **positionally, in append order** — never
  re-sorted. The first differing index (or a length mismatch) is the reported
  divergence.
- **`order-action` = diagnostic only.** Captured for future debugging / venue-call
  replay; the current replay engine does not diff them, and the skeleton harness
  does not yet emit them (the writer API supports them for later tasks).

## Ordering rule (load-bearing)

WAL/trace append order **is** the authoritative order. Replay and diff never
re-sort. Determinism comes from the virtual clock + event ordinals (see
`test/CLAUDE.md`), so the same inputs always produce the same `seq` sequence and
the same bytes.

## Versioning policy

Every record carries `v: 1`. `readTrace` **refuses** any record whose `v` is not
the supported version (hard error, fail loud) rather than silently mis-parsing an
older/newer artifact. Bump the version and add a migration path when the record
shape changes incompatibly.

## Config-header gap (known, revisit)

The header snapshots the interim `RuntimeStrategyConfig` (its hash + the object),
**not** a full `EffectiveConfig`. There is no `main.ts` / config-loader wiring yet
(the skeleton harness hardcodes this config), so a full effective-config snapshot
has nothing to snapshot. Revisit when config-loading composition lands — the
header should then carry the effective config and its revision hash.

## Promotion workflow (bless a trace as a golden)

```
npm run replay -- --promote <trace> [--name <name>]
```

Copies `<trace>` into `test/golden/fixtures/<name ?? basename(trace)>`. `--name`
must be a bare filename (no `/`). Regenerating the skeleton fixture specifically:

```
rm test/golden/fixtures/skeleton.trace.golden.jsonl
UPDATE_GOLDEN=1 npx vitest run test/golden/skeleton.test.ts
```
