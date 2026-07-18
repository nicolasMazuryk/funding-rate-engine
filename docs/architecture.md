# Architecture

The layer rules of this engine and **why** they hold, each mapped to how it is **enforced**. Source of truth: `docs/specs/08_system_overview.md` §2–§5. This doc is the working summary agents self-review against; where it and `08` disagree, `08` wins.

## Engineering principles (binding, `08` §2)

1. **Adapters at the edges, purity in the core.** All I/O and venue quirks live behind interfaces. The strategy runtime is deterministic and side-effect-free given its input event stream.
2. **Event-driven, not a loop of special cases.** One typed event stream (market ticks, funding-settlement events, order/fill events, timers) drives everything. Funding settlement is a first-class event, not a bolt-on.
3. **Fail loud, fail early.** Instruments, precision, and config validated at startup; a bad instrument or config aborts before any order.
4. **KISS / DRY / less code.** One config schema, one adapter interface, one FSM engine reused by intents and orders, one repository pattern. No speculative generality.

## Layers & the dependency rule (`08` §3)

```
┌─────────────────────────────────────────────┐
│  EDGES (impure): Exchange Adapters           │  ← specs 10, 11
│  ccxt + native WS clients, rate limiter,     │
│  market metadata, order I/O, private streams │
└───────────────┬───────────────▲─────────────┘
     events ↓    │               │  intents / commands ↑
┌───────────────▼───────────────┴─────────────┐
│  CORE (pure): Strategy Runtime               │  ← spec 12 + 01..07
│  scheduler → find opportunities → preflight  │
│  → strategy module → intent → exit policy    │
│  deterministic given (event stream, config)  │
└───────────────┬───────────────▲─────────────┘
     persist ↓   │               │  recover ↑
┌───────────────▼───────────────┴─────────────┐
│  SIDECARS: Persistence, Risk, Accounting     │  ← specs 13, 14, 15
│  WAL + Postgres, kill switch/breakers,       │
│  reconciliation & P&L                        │
└─────────────────────────────────────────────┘
```

**Dependency rule (the load-bearing invariant).** The core depends only on interfaces (ports). Adapters, persistence, and risk implement or observe those ports. The core imports **no** exchange library, **no** `pg`/Drizzle, **no** `ccxt`, **no** `ws`.

- **Why:** it is what makes the runtime testable in isolation — a fake adapter and a virtual clock exercise the whole core with zero credentials.
- **Enforcement:** an import-boundary lint restricting I/O imports inside `src/core/` — mechanism decided and landed in **task 0030**. Until then, the rule is upheld by code review and by this doc. `npm run verify` is the gate every change passes.

### Project layout (`08` §7, indicative beyond the boundary)

```
src/
  core/         # PURE — no I/O imports (runtime, intent, strategies, events, ports)
  adapters/     # IMPURE — implements ports (exchanges/<venue>, persistence)
  execution/    # order manager, position tracker, funding tracker
  risk/         # kill switch, breakers, flatten
  accounting/   # reconciliation, P&L, analytics
  config/       # env + yaml loaders, Zod schemas
  main.ts       # composition root: wires one instance
test/           # unit / integration / e2e
```

Layout note (task 0010 decision): persistence lives at `src/persistence/` in this repo, not `src/adapters/persistence/` as the `08` §7 tree shows. Legacy `src/execution/...` paths quoted inside specs are noise, not layout mandates (ROADMAP §3.7).

## The event stream — the spine (`08` §4)

A single in-process typed event bus. Every input to the core is one of these events, produced by the adapters; every output is an intent/command.

| Event | Producer | Consumers |
|---|---|---|
| `Timer` (`HH:58` scan, `T_settle+offset`, deadline) | Scheduler | Strategy runtime |
| `FundingPredicted { symbol, rate, ts }` | Public WS / REST poll | Opportunity finder |
| `FundingSettled { symbol, rate, T_settle }` | Funding schedule + settlement | Runtime, accounting |
| `FundingFeeAccrued { symbol, amount, fundingTime }` | Private WS (`funding_fee`) | S1-WS/S2/S6 gates, funding tracker |
| `MarketTick { symbol, price, ts }` | Public WS | S2 tracker, monitors |
| `OrderUpdate { clientOrderId, status, fillPx, qty }` | Private WS (REST fallback) | Order FSM, intent FSM |
| `PositionUpdate { symbol, qty, side }` | Private WS (REST reconcile) | Position tracker, risk |
| `BalanceUpdate { asset, free, used }` | Private WS | Preflight, risk |

Events are immutable value objects. The bus is synchronous within the instance (one strategy, one exchange → low fan-out) — no distributed broker (KISS). Ordering is per-symbol FIFO.

**WAL-before-side-effect** (`08` §8, spec 14 §2.1). Every transition is durably appended to the local WAL **before** the side effect it gates. Why: a crash resumes deterministically and Postgres latency stays off the hot path. Enforced by the persistence layer's ordering contract and its crash-recovery tests (task 0070 onward).

## Pattern inventory (`08` §5 — only where a pattern earns its place)

| Pattern | Where | Why |
|---|---|---|
| **Ports & Adapters (Hexagonal)** | core ↔ edges boundary | keeps the runtime pure and testable in isolation |
| **Adapter + Factory** | one `ExchangeAdapter` interface, one factory per venue | six venues behind one contract; add a venue = add one adapter |
| **Strategy** | strategy modules `01`–`07` | already the shape of the strategy set |
| **Finite State Machine (shared engine)** | intent lifecycle (`12`) and order lifecycle (`11`) | one FSM utility, two state tables — DRY |
| **Repository** | persistence (`14`) | core speaks to `Repo` interfaces, not Drizzle |
| **Observer / EventBus** | the spine (§4) | the event-driven core |
| **Circuit Breaker** | rate limiter & REST fallback (`10`, `13`) | bounded failure, fail-loud |
| **Registry** | adapters, strategies, error codes | lookup by key, no switch sprawl |

**Explicitly avoided** (overengineering): message brokers, microservices, plugin frameworks, generic rules engines, DI containers. One process per instance, wired in `main.ts`.

## How the rules are enforced (summary)

- **`npm run verify`** — the universal gate (strict `tsc`, `biome check`, `vitest`). Green in, green out; a task never leaves the repo red.
- **Import-boundary lint** — keeps `src/core/` free of I/O imports. Mechanism decided in **task 0030**.
- **Crash-recovery + golden-replay tests** — enforce WAL-before-side-effect and event-stream determinism (skeleton slice, task 0090).
- **Code review + this doc** — self-review every task against these rules (purity boundary, WAL ordering, fail-loud, KISS/DRY) before commit; see `docs/agent-workflow.md`.
