# Testing & Verification

**Document:** `17_testing.md` · includes `00_globals.md` by reference
**Covers:** unit, integration (exchanges), and end-to-end tests. Runner: **Vitest**.

**Conclusion first.** The architecture makes testing cheap: the **pure core** (`08` §3) is unit-tested with in-memory ports and no network; **adapters** are integration-tested against each venue's testnet; the whole instance is exercised **end-to-end** by replaying a recorded event stream through the real runtime with a simulated venue. Every strategy module must produce intents and output records conforming to the canonical schema and enums (`00_globals.md` §8.3, §10), so results are directly comparable across strategies, exchanges, and instances.

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

- **Selection & guards** (`12` §2): §7 guards (0.1 pp pre-filter, 60 s freshness, ordering), per-strategy thresholds incl. S6 signed-any.
- **Preflight & risk** (`12` §3, `13`): kill-switch rejection, min-notional skip, balance reject, precision rounding/floor.
- **Sizing & denomination** (`11` §2, `10` §4): `qty = amountUsd/price/contractSize`, `1000PEPE→PEPE`, lot-step flooring, ladder largest-remainder split with min-notional drops.
- **Intent & order FSMs** (`12` §5, `11` §6): every transition and failure edge, mapping to the exact `exit_reason`/`error_code` enums (`00_globals.md` §10) — one test per enum value so no terminal state is unreachable or ambiguous.
- **Cost model** (`12` §4): each strategy's profit condition holds for representative inputs; structurally-uneconomic configs are rejected.
- **Config validation** (`09`): bounds (`00_globals.md` §9.1), unit guards (`unit_suspect_fraction`, `retracement_pct > 1`), unknown-key rejection, per-exchange delta re-validation.

Property-style tests where they pay off (sizing/precision invariants; FSMs never reaching two terminals).

---

## 3. Integration tests (per exchange)

One suite per venue, run against testnet, verifying the adapter honors the one interface (`10` §2) identically:

- **Market load/filter:** only perp-USDT active swaps survive (`10` §3); normalization and precision match ccxt metadata (`10` §4).
- **Account setup:** one-way mode, isolated margin, leverage set in advance; `setLeverage` failure is a hard reject (`11` §1).
- **Order path:** WS-first place/cancel, REST fallback (OKX), `clientOrderId` idempotency (resubmit is a no-op), min-notional/precision rejection surfaces as typed `OrderRejected` (`10` §5, `11`).
- **Streams:** private (order/position/balance/funding-fee) and public (predicted funding, last price) produce the expected events; reconnect re-primes from REST (`11` §7).
- **Error taxonomy:** induced errors map to the shared typed set (`10` §5); rate limiter reserves the order lane (`10` §6).
- **Per-exchange deltas:** OKX timeout 45 s, OKX leverage 4 on S1, OKX REST fallback (`00_globals.md` §6) behave as configured.

These are the tests that catch venue quirks — the whole reason adapters exist.

---

## 4. End-to-end tests

Drive a full instance with a **simulated venue** (a fake adapter implementing the port, or a recorded event replay) plus a real Postgres:

- **Happy path per strategy:** replay a funding event → entry → monitor → exit; assert the produced trade record and `exit_reason` match expectation (one scenario per exit-policy kind, `00_globals.md` §Inventory).
- **Failure paths:** WS event miss → timeout exit (S1-WS/S2/S6); limit never fills → `limit_expired`/`ladder_no_fills`; S6 PRE_FUNDING abort ladder → `close_pre_funding_failed` alerting.
- **Crash recovery** (`14` §5): kill the process mid-intent, restart, assert deterministic resume/close and no double-submit (WAL + REST reconcile).
- **Kill switch / flatten** (`13`): `paused` rejects new intents; `flatten` closes tracked positions with `kill_switch_flatten`.

---

## 5. S6 shadow → canary verification

S6's entry path can't be exercised by a scripted event replay: MAIN's fill is causally gated on a live, account-level WS event, so its correctness can only be verified against real venue behavior. Verification instead follows the **shadow → canary** protocol (`07_strategy_6.md` §6):

- **Shadow phase:** the full state machine runs with order submission stubbed (log-only), measuring event arrival rate and latency distribution per venue.
- **Canary phase:** live at minimum size, gated on pre-registered acceptance thresholds — `funding_event_timeout` rate, MAIN slippage distribution, realized PRE overhead, funding-attribution audit, zero `close_pre_funding_failed` occurrences.

This suite encodes those thresholds as automated checks against the canary phase's logged trade data, and is the sole verification path for S6's entry sequence (its exit management — TP/SL/deadline — is covered by the standard unit and end-to-end suites like every other strategy).

---

## 6. CI

- `vitest run` for unit + e2e on every change; integration suites gated to testnet credentials.
- The **canonical-schema round-trip test** (`00_globals.md` §9.2): every parameter emitted to the live schema, re-parsed, and compared numerically against its canonical source — the last line of defense on the unit-mismatch defect class.
- Coverage focus on the FSMs, preflight, sizing, and config validation — the places a bug becomes a real order.
