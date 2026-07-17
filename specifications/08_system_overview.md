# System Overview — Live Trading Engine

**Document:** `08_system_overview.md` · entry point for the system spec set (`08`–`17`) · includes `00_globals.md` by reference
**Scope:** everything the live end-to-end trading system needs *around* the strategy logic. Strategy behavior itself is **not** re-specified here — it lives in `01_strategy_1.md` … `07_strategy_6.md` and is referenced, never duplicated.

**Conclusion first.** The system is a single **event-driven** engine per running instance: one exchange, one strategy, one sub-account (§Fleet, `16_fleet_deployment.md`). Adapters sit at the edges and turn venue I/O into a typed event stream; a deterministic **strategy runtime** consumes that stream and emits **intents**; an execution layer turns intents into orders and account-state changes. The same runtime core is shared with the backtester (`00_globals.md`: "one spec, two implementations") — only the edges differ (live adapters vs historical replay). Keep the core pure; keep the mess at the edges.

---

## 1. Document map (system spec set)

| Doc | Covers |
|---|---|
| `08_system_overview.md` (this) | Architecture, tech stack, npm libraries, event-driven core, design patterns, project layout, end-to-end flow. |
| `09_configuration.md` | `.env` + YAML, Zod validation, fail-loud startup, per-instance/fleet config. |
| `10_exchange_adapters_and_market_data.md` | Exchange clients, adapter interface, market load/filter, symbol normalization & precision, error taxonomy, rate limiter, public WS (predicted funding, last price), funding-rate history. |
| `11_execution_and_account_state.md` | Order management (WS-first, REST fallback), order FSM, idempotency, leverage/margin/position-mode setup, precision enforcement, sizing/denomination, private WS (orders, positions, balances, funding-fee), position & funding-fee tracking. |
| `12_strategy_runtime_and_intent_lifecycle.md` | Scheduler (HH:58 workflow), opportunity finding, preflight, cost model, entry→monitor→exit orchestration, intent FSM. |
| `13_risk_and_failure_modes.md` | Kill switch, circuit breakers, flatten, risk checks, failure catalog. |
| `14_persistence_and_recovery.md` | WAL, Postgres/Drizzle schema, crash recovery, idempotency at the store. |
| `15_accounting_and_reconciliation.md` | Post-trade accounting, system↔exchange reconciliation, P&L attribution, trade analytics. |
| `16_fleet_deployment.md` | Sub-accounts, 30 isolated instances (5×6), Docker, one-strategy-per-container. |
| `17_testing.md` | Unit, integration (exchanges), end-to-end, Vitest. |

Strategy files (`01`–`07`) and `00_globals.md` are the source of truth for strategy behavior, exit-reason/error-code registries (`00_globals.md` §12), parameter registry (§10.2), guards (§9), and safety mechanisms (§7). This set never contradicts them.

---

## 2. Engineering principles (binding, from the brief)

1. **Adapters at the edges, purity in the core.** All I/O and venue quirks live behind interfaces. The strategy runtime is deterministic and side-effect-free given its input event stream.
2. **Event-driven, not a loop of special cases.** One typed event stream (market ticks, funding-settlement events, order/fill events, timers) drives everything. Funding settlement is a **first-class event**, not a bolt-on.
3. **Fail loud, fail early.** Instruments, precision, and config are validated at **startup**; a bad instrument or config aborts the process before any order.
4. **KISS / DRY / less code.** One canonical config schema, one adapter interface, one FSM engine reused by intents and orders, one repository pattern. No speculative generality.

---

## 3. Clean architecture — layers

```
            ┌─────────────────────────────────────────────┐
            │  EDGES (impure): Exchange Adapters           │  ← 10, 11
            │  ccxt + native WS clients, rate limiter,     │
            │  market metadata, order I/O, private streams │
            └───────────────┬───────────────▲─────────────┘
                 events ↓    │               │  intents / commands ↑
            ┌───────────────▼───────────────┴─────────────┐
            │  CORE (pure): Strategy Runtime               │  ← 12 + 01..07
            │  scheduler → find opportunities → preflight  │
            │  → strategy module → intent → exit policy    │
            │  deterministic given (event stream, config)  │
            └───────────────┬───────────────▲─────────────┘
                 persist ↓   │               │  recover ↑
            ┌───────────────▼───────────────┴─────────────┐
            │  SIDECARS: Persistence, Risk, Accounting     │  ← 13, 14, 15
            │  WAL + Postgres, kill switch/breakers,       │
            │  reconciliation & P&L                        │
            └─────────────────────────────────────────────┘
```

**Dependency rule:** the core depends only on interfaces (ports). Adapters, persistence, and risk implement or observe those ports. The core imports no exchange library, no `pg`, no `ccxt`. This is what makes the runtime testable in isolation and reusable by the backtester.

---

## 4. The event stream (the spine)

A single in-process typed event bus. Every input to the core is one of these events; every output is an intent/command. Backtest replays the same event types from history; live produces them from adapters.

| Event | Producer | Consumers |
|---|---|---|
| `Timer` (e.g. `HH:58:00` scan, `T_settle+offset`, deadline) | Scheduler | Strategy runtime |
| `FundingPredicted { symbol, rate, ts }` | Public WS / REST poll | Opportunity finder |
| `FundingSettled { symbol, rate, T_settle }` | Funding schedule + settlement | Runtime, accounting |
| `FundingFeeAccrued { symbol, amount, fundingTime }` | Private WS (`funding_fee`) | S1-WS/S2/S6 gates, funding tracker |
| `MarketTick { symbol, price, ts }` (last price / trades) | Public WS | S2 tracker, monitors |
| `OrderUpdate { clientOrderId, status, fillPx, qty }` | Private WS (REST fallback) | Order FSM, intent FSM |
| `PositionUpdate { symbol, qty, side }` | Private WS (REST reconcile) | Position tracker, risk |
| `BalanceUpdate { asset, free, used }` | Private WS | Preflight, risk |

**Design note.** Events are immutable value objects. The bus is synchronous within the instance (single strategy, single exchange → low fan-out); no distributed broker is warranted (KISS). Ordering is per-symbol FIFO.

---

## 5. Design patterns (only where they earn their place)

| Pattern | Where | Why |
|---|---|---|
| **Ports & Adapters (Hexagonal)** | core ↔ edges boundary | keeps the runtime pure & backtest-shareable |
| **Adapter + Factory** | one `ExchangeAdapter` interface, one factory per venue | six venues behind one contract; add a venue = add one adapter |
| **Strategy** | strategy modules `01`–`07` | already the shape of the strategy set |
| **Finite State Machine (shared engine)** | intent lifecycle (`12`) and order lifecycle (`11`) | one tiny FSM utility, two state tables — DRY |
| **Repository** | persistence (`14`) | core speaks to `Repo` interfaces, not Drizzle |
| **Observer / EventBus** | §4 | the event-driven spine |
| **Circuit Breaker** | rate limiter & REST fallback (`10`, `13`) | bounded failure, fail-loud |
| **Registry** | adapters, strategies, error codes | lookup by key, no switch sprawl |

Explicitly **avoided** (overengineering): message brokers, microservices, plugin frameworks, generic rules engines, dependency-injection containers. One process per instance, wired in `main.ts`.

---

## 6. Tech stack

| Concern | Choice |
|---|---|
| Language / runtime | **Node.js + TypeScript (`strict: true`)** |
| Exchange I/O | **ccxt** (unified REST + market metadata) + native venue libs for WS/order speed (`binance`, `bybit-api`, `okx-api`, `bitget-api`, `gateio-api`, `kucoin-api`) |
| WebSockets | native venue libs (private + public streams); `ws` where a raw socket is needed |
| Persistence | **Postgres** via **Drizzle ORM** (typed schema, migrations) |
| Config | **YAML** (`yaml`) for everything non-secret; **dotenv** for secrets; **Zod** for validation |
| Logging | **Pino** (structured JSON, one logger per instance with `exchange`+`strategy` bindings) |
| Containerization | **Docker** (one image, one container per instance) |
| Testing | **Vitest** (unit, integration, e2e) |

### NPM libraries (canonical list)

`ccxt`, `binance`, `bybit-api`, `okx-api`, `bitget-api`, `gateio-api`, `kucoin-api`, `drizzle-orm`, `pg`, `zod`, `yaml`, `dotenv`, `pino`, `ws`, `vitest`.

**ccxt vs native split (binding rule):** ccxt is the source of truth for **market metadata, precision, limits, and REST fallback**; native libraries own the **hot path** (private/public WS streams and low-latency WS order submit/cancel). One adapter wraps both behind the `ExchangeAdapter` interface so the core never sees which library served a call. See `10` §2.

---

## 7. Project layout (indicative, not prescriptive beyond the boundary)

```
src/
  core/                 # PURE — no I/O imports
    runtime/            # scheduler, opportunity finder, preflight, cost model  (12)
    intent/             # intent FSM + exit-policy dispatch                     (12)
    strategies/         # 01..07 strategy modules (shared with backtest)
    events/             # event types + bus interface                          (08 §4)
    ports/              # ExchangeAdapter, Repo, Clock, RiskGate interfaces
  adapters/             # IMPURE — implements ports
    exchanges/<venue>/  # ccxt + native client, WS streams, error mapping      (10, 11)
    persistence/        # Drizzle repos, WAL                                    (14)
  execution/            # order manager, position tracker, funding tracker      (11)
  risk/                 # kill switch, breakers, flatten                        (13)
  accounting/           # reconciliation, P&L, analytics                        (15)
  config/               # env + yaml loaders, Zod schemas                       (09)
  main.ts               # composition root: wires one instance
test/                   # unit / integration / e2e                             (17)
```

---

## 8. End-to-end flow (happy path, one event cycle)

```
HH:58:00  Timer → opportunity finder scans predicted funding for enabled strategy's
          threshold (00_globals §9 guards) → shortlist symbols.
HH:59:5x  For each candidate at T_settle − entryOffsetSeconds: preflight
          (balance, precision, min-notional, risk, kill switch) → build Intent.
          Intent FSM: SELECTED → SUBMITTING_ENTRY.
~HH:00:00 Execution places entry order (WS-first, REST fallback) → OrderUpdate(filled)
          → Intent: ENTRY_FILLED → MONITORING. Position tracker + funding tracker update.
HH:00:0x  Strategy exit policy (per 01..07) manages TP/SL/deadline or funding-fee gate,
          driven by MarketTick / FundingFeeAccrued events.
          Exit fires → Intent: EXITING → CLOSED with exit_reason (00_globals §12.1).
after     Post-exit sweep (00_globals §7.2) → accounting reconciles fills, funding, P&L (15).
```

Every transition is persisted (WAL, `14`) before the side effect, so a crash resumes deterministically.

---

## 9. What is explicitly out of scope here

Backtester internals (owned by `00_globals.md` + strategy §6 sections), the strategies' own entry/exit math, and the backtest simulation rules. This set specifies the **live** system that runs the same strategy modules against real venues.
