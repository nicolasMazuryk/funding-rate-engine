# Exchange Adapters & Market Data

**Document:** `10_exchange_adapters_and_market_data.md` · includes `00_globals.md` by reference
**Covers:** the six venue clients, the single adapter interface, market loading/filtering, symbol normalization & precision, the error taxonomy, the rate limiter, public WS streams (predicted funding, last price), and funding-rate history.

**Conclusion first.** Every venue hides behind **one `ExchangeAdapter` interface**. ccxt provides unified REST + market metadata (the source of truth for precision and limits); native venue libraries provide the low-latency WS streams and WS order path. The adapter turns venue responses and socket messages into the **typed event stream** (`08` §4) and a small set of typed errors (§5). The core never imports a venue library. Add a venue = write one adapter; change nothing in the core.

---

## 1. Exchanges (all USDT-margined perpetual futures)

Binance, Bybit, OKX, Bitget, Gate.io, KuCoin. Each runs in its own isolated instance/sub-account (`16_fleet_deployment.md`). Per-venue quirks (fees, stagger, timeouts, REST-fallback, leverage) are data in `exchanges.yaml` (`09` §4), not code branches.

---

## 2. Adapter interface (the one contract)

```ts
interface ExchangeAdapter {
  // lifecycle
  init(): Promise<void>;                    // load markets, validate instruments, open streams (fail-loud)
  close(): Promise<void>;

  // account setup (done in advance, before any trade — §6)
  setLeverage(symbol, leverage): Promise<void>;
  setMarginMode(symbol, 'isolated'): Promise<void>;
  setPositionMode('one_way'): Promise<void>;

  // market metadata (ccxt-backed)
  markets(): Market[];                      // filtered: perp-USDT only (§3)
  normalize(symbol): Instrument;            // §4

  // orders (native WS-first, REST fallback — see 11)
  placeOrder(req): Promise<OrderAck>;
  cancelOrder(clientOrderId): Promise<void>;
  getOrder(clientOrderId): Promise<Order>;  // REST fill-poll
  getPositions(): Promise<Position[]>;      // REST ground truth
  getBalance(): Promise<Balance>;

  // funding
  predictedFunding(symbol): Promise<Rate>;  // REST fallback for the public stream
  fundingHistory(symbol, range): Promise<FundingEvent[]>;

  // streams (native) — push onto the event bus (08 §4)
  streams: { public: PublicStream; private: PrivateStream };
}
```

**ccxt vs native (binding split, `08` §6):** metadata/precision/limits and every REST fallback go through **ccxt**; hot-path WS (streams + WS order submit/cancel) goes through the **native lib**. The adapter is the only place that knows which. A `ClientFactory` builds both clients from the exchange profile + secrets.

---

## 3. Market loading & filtering

At `init()`:

1. `ccxt.loadMarkets()`.
2. **Filter to tradable perpetual USDT swaps only:** `type == 'swap' && linear && quote == 'USDT' && active`. Everything else (spot, inverse, coin-margined, expiries, delisted) is dropped.
3. Apply optional `symbols.deny` from config (`09` §3).
4. Build the in-memory `Instrument` registry (§4), keyed by **normalized** symbol.

The filtered set is the universe the opportunity finder (`12`) scans. `ccxt.loadMarkets()` run every hour and reload an updated list of markets. Loaded **at startup**, reloaded/updated every hour. The funding *schedule* per symbol is re-read per event (intervals can change — `00_globals.md` §8.1), the tradable-instrument set is reloaded once per hour.

---

## 4. Symbol normalization, precision & denomination

One `Instrument` per symbol, derived from ccxt market data, validated at startup (fail-loud):

| Field | Meaning | Use |
|---|---|---|
| `normalized` | canonical name, e.g. `1000PEPE` venue symbol → **`PEPE`** internally | events, DB, cross-venue analytics |
| `venueSymbol` | exact venue string for API calls | adapter only |
| `contractSize` | units of base per contract | sizing/denomination (§6, `11`) |
| `pricePrecision`, `amountPrecision` | tick / lot step | order rounding |
| `minNotional` (`minCost`), `minQty` | exchange minimums | preflight & feasibility (`11`, `12`) |
| `fundingIntervalHours` | 1 / 2 / 4 / 8 | schedule (re-read per event) |

**Denomination (binding).** Venues expressing price in multiples (e.g. `1000PEPE`) are normalized so all internal math, sizing, and P&L use the **base unit**; the adapter converts to/from the venue's contract/price multiple **only at the API boundary**. `qty = amountUsd / price / contractSize`, floored to `amountPrecision` (`00_globals.md` §4). A normalization or precision mismatch at startup **aborts the process** — a wrong `contractSize` silently mis-sizes every order.

---

## 5. Error handling & error taxonomy

Venue errors (ccxt and native) are mapped to a **small typed set** the core understands. Raw venue codes are logged but never leak into core logic (DRY — one handler, not per-venue switches).

| Typed error | Trigger (examples) | Handling |
|---|---|---|
| `RateLimited` | HTTP 429, venue rate-limit code | back off via rate limiter (§7); retry |
| `WsTimeout` | no WS ack within window | REST fallback (OKX only for orders, `00_globals.md` §6); else retry/abort |
| `OrderRejected` | min-notional, precision, reduce-only violation, margin | surfaced to order FSM (`11`) → intent error_code |
| `InsufficientBalance` | margin/balance | preflight reject (`12`) / risk event (`13`) |
| `AuthError` | bad key/permission/IP | **fatal at startup**, fail-loud |
| `NetworkError` | transient socket/HTTP | retry with backoff; feeds circuit breaker (`13`) |
| `NotFound` | unknown order/symbol | reconcile via REST ground truth (`11`, `15`) |
| `VenueUnavailable` | 5xx, maintenance | circuit-open; pause new intents (`13`) |

Mapping tables live per adapter; the union type is shared. Consecutive `NetworkError`/`VenueUnavailable` trip the circuit breaker (`13` §Circuit breakers). Order-specific rejections carry through to the `error_code` registry (`00_globals.md` §10.2).

---

## 6. Rate limiter

Per-exchange token-bucket sized from the venue's published limits (`exchanges.yaml`). Binding rules from `00_globals.md` §6:

- **Reserve 10%** of each venue's budget exclusively for **order submit/cancel** — market-data polling can never starve the order path.
- Weighted costs per endpoint (ccxt exposes weights); the limiter accounts weight, not just call count.
- On depletion: queue and delay non-critical calls; **never** silently drop an order submit — if the order lane is exhausted it raises `RateLimited` to the order FSM for explicit handling.
- Shared by REST and WS-order submission accounting where the venue counts both.

One limiter instance per adapter (one instance = one sub-account, so no cross-instance contention by construction — `16`).

---

## 7. Public WS streams (market data)

Two public feeds, pushed onto the event bus (`08` §4):

| Stream | Event | Consumers | Fallback |
|---|---|---|---|
| **Predicted next funding rate** | `FundingPredicted { symbol, rate, ts }` | opportunity finder (`12`), selection guards (`00_globals.md` §7) | REST `predictedFunding` poll (freshness ≤ 60 s, `00_globals.md` §7) |
| **Last price / trades** | `MarketTick { symbol, price, ts }` | S2 retracement tracker, exit monitors (`11`, `12`) | REST ticker poll |

- **Freshness gate:** a predicted-rate observation older than **60 s** is treated as *no signal*, not a stale trigger (`00_globals.md` §7). The adapter timestamps every observation.
- **Subscription scope:** subscribe only to the filtered perp-USDT universe (§3); for the last-price stream, narrow to the shortlist around each event window to stay well inside rate/bandwidth budgets.
- **Reconnect:** automatic with exponential backoff; on gap, a REST snapshot re-primes state before resuming. Private streams are covered in `11`.

---

## 8. Funding rates (data)

| Need | Source | Notes |
|---|---|---|
| Predicted next rate | public WS (§7) + REST fallback | selection input, live (`00_globals.md` §3.2) |
| Settled rate | REST / private funding-fee event | accrual truth (`00_globals.md` §3.1/§3.2) |
| Funding history | REST `fundingHistory` | reconciliation & analytics (`15`); schedule/interval discovery |
| Funding **schedule** (`T_settle`, interval) | REST per symbol, **re-read per event** | intervals change dynamically (`00_globals.md` §8.1) — never cache as constant |

Predicted and settled rates can diverge near a threshold (`00_globals.md` §3.2); the engine uses the predicted rate at decision time and books the settled rate on accrual. The funding-fee **accrual event** (real-time credit/charge) is a private stream, specified in `11`.

---

## 9. Purity notes

- The adapter is the **only** impure boundary for exchange I/O; the core consumes only the typed event stream (`08` §3) and never talks to a venue directly.
- No venue-specific behavior lives in the core: everything venue-shaped is either data (`exchanges.yaml`) or an adapter mapping (§4, §5). This is the DRY guarantee that keeps six venues from becoming six code paths.
