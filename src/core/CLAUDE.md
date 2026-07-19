# CLAUDE.md — `src/core/` (the pure core)

This directory is the **deterministic strategy runtime**. Given `(event stream, config)` it is pure: same inputs → same intents/commands, no wall-clock reads, no I/O, no venue quirks. That purity is what makes the runtime testable without a venue (`08_system_overview.md` §3; `12` §7).

## The purity rule (load-bearing)

`src/core/**` **imports no I/O**. Forbidden — and mechanically enforced by a Biome `noRestrictedImports` override scoped to `src/core/**` (see root `biome.json` → `overrides`; `npm run check` fails on violation):

- **I/O packages:** `ccxt`, `pg`, `drizzle-orm`, `ws`, `pino`.
- **Node built-ins:** `fs`, `net`, `http` (and their `node:` forms).
- **Impure sibling layers:** anything under `src/adapters/**`, `src/persistence/**`, `src/execution/**` (relative or aliased).

The core depends **only on ports** — the interfaces in `src/core/ports/` (`ExchangeAdapter`, `Clock`, `Repo`, `RiskGate`, `EventBus`). Adapters, persistence, and risk *implement* those ports; the core never sees the implementation. Time comes from `Clock`, never `Date.now()`/`setTimeout`; timestamps are epoch-ms `number`, never `Date`.

## What belongs here

- `events/` — the event types (`08` §4) and the synchronous per-symbol-FIFO bus.
- `ports/` — the interfaces the core depends on. No implementations.
- `runtime/` — scheduler, opportunity finder, preflight, cost model (`12`). *(later tasks)*
- `intent/` — intent FSM + exit-policy dispatch (`12`). *(later tasks)*
- `strategies/` — the `01`–`07` strategy modules (pure selection/exit math). *(later tasks)*

## What does NOT belong here

Anything that touches the outside world: exchange clients, DB access, sockets, file reads, structured logging, config loading. Those live in `src/adapters/`, `src/persistence/`, `src/execution/`, `src/config/`. If you reach for an I/O import inside `core/`, the design is wrong — add a port instead.

See `docs/architecture.md` for the purity boundary, enforcement, and the dependency rule in full.

## Conventions specific to core

- **Depend on ports, not implementations.** The core references interfaces; `main.ts` wires the concrete adapters.
- **Events are immutable** (`readonly` fields) value objects.
- **Closed unions stay exhaustive.** Switch over `EngineEvent['type']` (and later FSM states) with `assertNever` in the default branch so a missing case is a compile error.
- **Units are load-bearing** (`00_globals` §1.2): timestamps are epoch-ms UTC suffixed `Ms`; funding rates and thresholds are **signed percent** (`0.3` = 0.30%) — state the unit in a doc comment on the field.
