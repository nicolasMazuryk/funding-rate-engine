# Testing & Verification

**Document:** `17_testing.md` · includes `00_globals.md` by reference
**Covers:** unit, integration (exchanges), and end-to-end tests. Runner: **Vitest**.

**Conclusion first.** The architecture makes testing cheap: the **pure core** (`08` §3) is unit-tested with in-memory ports and no network; **adapters** are integration-tested against each venue's testnet; the whole instance is exercised **end-to-end** by replaying a recorded event stream through the real runtime with a simulated venue. The single most valuable test is **live↔backtest parity**: the same strategy module, fed the same events, must produce the same intents and the same output schema (`00_globals.md` §10.3, §12).

---

## 1. Test layers

| Layer | Scope | Dependencies | Speed |
|---|---|---|---|
| **Unit** | pure core: selection, preflight, cost model, intent/order FSMs, sizing, symbol normalization | none (in-memory ports) | fast, deterministic |
| **Integration** | adapters vs each venue: market load/filter, precision, WS streams, order path, error mapping | venue **testnet** / sandbox | slower, networked |
| **End-to-end** | full instance: scheduler → intent → execution → persistence → accounting | simulated venue + real Postgres | medium |

---

## 2. Unit tests (the bulk)

Because the core imports only ports (`08` §5), everything below is testable without a network or DB:

- **Selection & guards** (`12` §2): §9 guards (0.1 pp pre-filter, 60 s freshness, ordering), per-strategy thresholds incl. S6 signed-any.
- **Preflight & risk** (`12` §3, `13`): kill-switch rejection, min-notional skip, balance reject, precision rounding/floor.
- **Sizing & denomination** (`11` §2, `10` §4): `qty = amountUsd/price/contractSize`, `1000PEPE→PEPE`, lot-step flooring, ladder largest-remainder split with min-notional drops.
- **Intent & order FSMs** (`12` §5, `11` §6): every transition and failure edge, mapping to the exact `exit_reason`/`error_code` enums (`00_globals.md` §12) — one test per enum value so no terminal state is unreachable or ambiguous.
- **Cost model** (`12` §4): each strategy's profit condition holds for representative inputs; structurally-uneconomic configs are rejected.
- **Config validation** (`09`): bounds (`00_globals.md` §11.1), unit guards (`unit_suspect_fraction`, `retracement_pct > 1`), unknown-key rejection, per-exchange delta re-validation.

Property-style tests where they pay off (sizing/precision invariants; FSMs never reaching two terminals).

---

## 3. Integration tests (per exchange)

One suite per venue, run against testnet, verifying the adapter honors the one interface (`10` §2) identically:

- **Market load/filter:** only perp-USDT active swaps survive (`10` §3); normalization and precision match ccxt metadata (`10` §4).
- **Account setup:** one-way mode, isolated margin, leverage set in advance; `setLeverage` failure is a hard reject (`11` §1).
- **Order path:** WS-first place/cancel, REST fallback (OKX), `clientOrderId` idempotency (resubmit is a no-op), min-notional/precision rejection surfaces as typed `OrderRejected` (`10` §5, `11`).
- **Streams:** private (order/position/balance/funding-fee) and public (predicted funding, last price) produce the expected events; reconnect re-primes from REST (`11` §7).
- **Error taxonomy:** induced errors map to the shared typed set (`10` §5); rate limiter reserves the order lane (`10` §6).
- **Per-exchange deltas:** OKX timeout 45 s, OKX leverage 4 on S1, OKX REST fallback (`00_globals.md` §8) behave as configured.

These are the tests that catch venue quirks — the whole reason adapters exist.

---

## 4. End-to-end tests

Drive a full instance with a **simulated venue** (a fake adapter implementing the port, or a recorded event replay) plus a real Postgres:

- **Happy path per strategy:** replay a funding event → entry → monitor → exit; assert the produced trade record and `exit_reason` match expectation (one scenario per exit-policy kind, `00_globals.md` §Inventory).
- **Failure paths:** WS event miss → timeout exit (S1-WS/S2/S6); limit never fills → `limit_expired`/`ladder_no_fills`; S6 PRE_FUNDING abort ladder → `close_pre_funding_failed` alerting.
- **Crash recovery** (`14` §5): kill the process mid-intent, restart, assert deterministic resume/close and no double-submit (WAL + REST reconcile).
- **Kill switch / flatten** (`13`): `paused` rejects new intents; `flatten` closes tracked positions with `kill_switch_flatten`.

---

## 5. Live↔backtest parity (the keystone verification)

The strategy modules are shared between live and backtest (`08` §3). A dedicated suite feeds an **identical event stream** to both paths and asserts:

- same selection decisions and intents;
- same terminal enums (`00_globals.md` §12) and output-variable schema (`00_globals.md` §10.3);
- documented conservatism/optimism biases (`00_globals.md` §14) are the *only* permitted differences (e.g. settled-rate proxy, trade-through fills).

This is what guarantees the backtested edge is the thing actually being traded. **Exception:** S6 is not backtestable (`07_strategy_6.md` §6.1); its verification is the **shadow → canary** protocol (`07_strategy_6.md` §6.2), which this suite encodes as acceptance-metric checks against pre-registered thresholds rather than a parity comparison.

---

## 6. CI

- `vitest run` for unit + e2e on every change; integration suites gated to testnet credentials.
- The **canonical-schema round-trip test** (`00_globals.md` §11.2): every parameter emitted to both schema projections, re-parsed, compared numerically — the last line of defense on the unit-mismatch defect class.
- Coverage focus on the FSMs, preflight, sizing, and config validation — the places a bug becomes a real order.
