/**
 * `ExchangeAdapter` port and its value types
 * (`10_exchange_adapters_and_market_data.md` §2 interface, §4 `Instrument`;
 * `11_execution_and_account_state.md` §6 order FSM states).
 *
 * Every venue hides behind this one contract. ccxt backs market metadata and REST
 * fallback; native libs own the hot-path WS — the adapter is the only place that
 * knows which. The core imports no venue library; it consumes only the typed
 * event stream (`08` §4) and these interfaces.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/** Position/trade direction (`00_globals.md` §1.1). */
export type Side = 'long' | 'short'

/** Order type by fill lane (`11` §6; fee class per `00_globals.md` §4). */
export type OrderType = 'market' | 'limit' | 'stop'

/**
 * Typed venue-error taxonomy — the 8 names from `10` §5. **Name-only placeholder**:
 * task 0200 replaces/extends this with the full mapped taxonomy (per-adapter Binance
 * mapping table + retry/backoff semantics + rate limiter). Declared here in the ports
 * file (core-visible) so it does not collide with 0200's later adapter-local map, and
 * so 0160's sim can stamp {@link ../events/types.ts}.OrderUpdate.errorKind today.
 */
export type VenueErrorKind =
  | 'RateLimited'
  | 'WsTimeout'
  | 'OrderRejected'
  | 'InsufficientBalance'
  | 'AuthError'
  | 'NetworkError'
  | 'NotFound'
  | 'VenueUnavailable'

/** Order FSM states (`11_execution_and_account_state.md` §6). Terminal states feed the intent FSM. */
export type OrderStatus =
  | 'NEW'
  | 'SUBMITTING'
  | 'OPEN'
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'FAILED'

/** Margin mode — isolated only, set once in advance (`11` §1). */
export type MarginMode = 'isolated'

/** Position mode — one-way only, set once in advance (`11` §1). */
export type PositionMode = 'one_way'

/** Tradable status of a venue market (`12` §3 preflight market-status check). */
export type MarketStatus = 'trading' | 'halted' | 'delisted'

// ── Market metadata ──────────────────────────────────────────────────────────

/** A filtered venue market: perp-USDT, linear, active (`10` §3). */
export interface Market {
  /** Canonical internal name (`10` §4 denomination). */
  readonly normalized: string
  /** Exact venue string for API calls (adapter boundary only). */
  readonly venueSymbol: string
  readonly status: MarketStatus
}

/**
 * One `Instrument` per symbol, derived from ccxt market data and validated at
 * startup — fail-loud (`10` §4). A wrong `contractSize` silently mis-sizes every
 * order, so precision/normalization mismatches abort the process.
 */
export interface Instrument {
  /** Canonical name, e.g. venue `1000PEPE` → `PEPE` internally. */
  readonly normalized: string
  /** Exact venue string for API calls. */
  readonly venueSymbol: string
  /** Units of base per contract; sizing uses `qty = amountUsd / price / contractSize`. */
  readonly contractSize: number
  /** Tick — price rounding step. */
  readonly pricePrecision: number
  /** Lot step — amount rounding step. */
  readonly amountPrecision: number
  /** Exchange minimum notional (ccxt `minCost`), quote currency. */
  readonly minNotional: number
  /** Exchange minimum order quantity. */
  readonly minQty: number
  /** Funding interval, hours (1 / 2 / 4 / 8); re-read per event (`00_globals.md` §8.1). */
  readonly fundingIntervalHours: number
}

// ── Orders, positions, balances ──────────────────────────────────────────────

/** A request to place one order (`11` §3–§4). Prices/qty are in **base units** (`10` §4). */
export interface OrderRequest {
  /** Normalized symbol. */
  readonly symbol: string
  readonly side: Side
  readonly type: OrderType
  readonly qty: number
  /** Required for `limit`, ignored for `market`. */
  readonly price?: number
  /** Deterministic idempotency key `f(intentId, leg, attempt)` (`11` §4). */
  readonly clientOrderId: string
  /** Reduce-only close (sweeps, flatten). */
  readonly reduceOnly?: boolean
  /** Expiry for limit orders, epoch ms UTC → `EXPIRED` (`11` §6). */
  readonly expireAt?: number
}

/** Venue acknowledgement of a submitted order. */
export interface OrderAck {
  readonly clientOrderId: string
  readonly accepted: boolean
  /** Venue-assigned order id, when the venue returns one. */
  readonly venueOrderId?: string
}

/** Order ground truth from a REST fill-poll (`getOrder`, `11` §6). */
export interface Order {
  readonly clientOrderId: string
  readonly venueOrderId?: string
  readonly symbol: string
  readonly side: Side
  readonly type: OrderType
  readonly status: OrderStatus
  /** Fill-weighted average fill price, when (partially) filled. */
  readonly fillPx?: number
  /** Filled quantity, base units. */
  readonly qty?: number
  /** Reduce-only flag, when the venue reports it — the pre-entry stale-sweep (`13`, 0380) filters on it. */
  readonly reduceOnly?: boolean
}

/** An open position (`getPositions` REST ground truth). */
export interface Position {
  readonly symbol: string
  readonly side: Side
  /** Signed/absolute per `side`; base units. */
  readonly qty: number
  /** Average entry price, when open. */
  readonly entryPrice?: number
}

/** Account balance for one asset (`getBalance`; mirrors {@link ../events/types.ts}.BalanceUpdate). */
export interface Balance {
  readonly asset: string
  readonly free: number
  readonly used: number
}

// ── Funding ──────────────────────────────────────────────────────────────────

/** A funding rate reading (`predictedFunding` REST fallback). */
export interface Rate {
  readonly symbol: string
  /** Funding rate, signed percent (`00_globals.md` §1.1 `F`). */
  readonly rate: number
  /** Reading time, epoch ms UTC. */
  readonly ts: number
}

/** A historical settled funding event (`fundingHistory`). */
export interface FundingEvent {
  readonly symbol: string
  /** Settled funding rate, signed percent. */
  readonly rate: number
  /** `T_settle`, epoch ms UTC. */
  readonly settleTs: number
}

/**
 * One funding-income credit/charge on the account (`fundingIncome`). Distinct from
 * {@link FundingEvent}: `fundingHistory` returns the settled *rate*, this returns the
 * account *credit* — the only thing that confirms *your* position was actually paid,
 * which is the funding gate's REST safety net (task 0290; `00_globals.md` §6).
 */
export interface FundingIncome {
  readonly symbol: string
  /** Funding amount in quote currency (USDT); signed — credit positive, charge negative. */
  readonly amount: number
  /** `T_drop`, epoch ms UTC. */
  readonly fundingTime: number
}

/** Inclusive time range for history queries, epoch ms UTC. */
export interface TimeRange {
  readonly fromTs: number
  readonly toTs: number
}

// ── Streams ──────────────────────────────────────────────────────────────────
//
// Native WS streams push onto the event bus (`08` §4). These surfaces are
// deliberately thin here; they are sharpened when the Binance public/private
// WS adapters land (tasks 0210 / 0220).

/** Public market-data stream: predicted funding, last price (`10` §7). */
export interface PublicStream {
  /**
   * Subscribe the predicted-funding universe (`FundingPredicted` per symbol). The
   * Binance impl fans this out over the single all-market mark-price array stream and
   * publishes only for symbols in this set (`10` §7).
   */
  subscribe(symbols: readonly string[]): Promise<void>
  /** Subscribe last-price ticks (`MarketTick`) for the given normalized symbols (shortlist). */
  subscribeTicks(symbols: readonly string[]): Promise<void>
  /** Drop last-price ticks for the given normalized symbols; symmetric with {@link subscribeTicks}. */
  unsubscribeTicks(symbols: readonly string[]): Promise<void>
  close(): Promise<void>
}

/** Private account stream: orders, positions, balances, funding-fee (`11` §7). */
export interface PrivateStream {
  subscribe(): Promise<void>
  close(): Promise<void>
}

// ── The adapter ──────────────────────────────────────────────────────────────

/** The single contract every venue implements (`10` §2, verbatim shape). */
export interface ExchangeAdapter {
  // lifecycle
  /** Load markets, validate instruments, open streams — fail-loud (`10` §3). */
  init(): Promise<void>
  close(): Promise<void>

  // account setup (done in advance, before any trade — `11` §1)
  setLeverage(symbol: string, leverage: number): Promise<void>
  setMarginMode(symbol: string, mode: MarginMode): Promise<void>
  setPositionMode(mode: PositionMode): Promise<void>

  // market metadata (ccxt-backed)
  /** Filtered universe: perp-USDT only (`10` §3). */
  markets(): Market[]
  /** Normalize a symbol to its validated {@link Instrument} (`10` §4). */
  normalize(symbol: string): Instrument

  // orders (native WS-first, REST fallback — `11`)
  placeOrder(req: OrderRequest): Promise<OrderAck>
  cancelOrder(clientOrderId: string): Promise<void>
  /** REST fill-poll. */
  getOrder(clientOrderId: string): Promise<Order>
  /**
   * Open (non-terminal) orders, optionally filtered to one normalized `symbol` — the
   * pre-entry stale reduce-only sweep (`13`, 0380). REST ground truth like {@link getPositions}.
   */
  getOpenOrders(symbol?: string): Promise<Order[]>
  /** REST ground truth. */
  getPositions(): Promise<Position[]>
  getBalance(): Promise<Balance>

  // funding
  /** REST fallback for the public stream. */
  predictedFunding(symbol: string): Promise<Rate>
  fundingHistory(symbol: string, range: TimeRange): Promise<FundingEvent[]>
  /**
   * Account funding-income credits over `range` — the funding gate's REST safety net
   * (task 0290; `00_globals.md` §6). Confirms *your* position was paid, unlike the
   * rate-only {@link fundingHistory}.
   */
  fundingIncome(symbol: string, range: TimeRange): Promise<FundingIncome[]>

  // streams (native) — push onto the event bus (`08` §4)
  readonly streams: { readonly public: PublicStream; readonly private: PrivateStream }
}
