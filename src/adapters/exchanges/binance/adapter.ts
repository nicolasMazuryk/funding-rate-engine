/**
 * Binance {@link ExchangeAdapter} — market metadata only (task 0190). `init()` loads
 * markets via ccxt, filters to active linear USDT perps, builds a validated
 * `Instrument` registry (fail-loud on any anomaly), reloads it hourly, and serves the
 * synchronous `markets()`/`normalize()` reads plus funding REST.
 *
 * Everything trade-side — orders, positions, balances, account setup, WS streams — is
 * a `NotImplemented` stub filled by 0200–0240. The taxonomy + rate limiter are 0200;
 * this file builds **no** error infra (KISS). Mirrors the sim's shape so the same core
 * trades against either venue behind the one port.
 */

import type { Clock, TimerHandle } from '../../../core/ports/clock.js'
import type {
  Balance,
  ExchangeAdapter,
  FundingEvent,
  Instrument,
  MarginMode,
  Market,
  Order,
  OrderAck,
  OrderRequest,
  Position,
  PositionMode,
  Rate,
  TimeRange,
} from '../../../core/ports/exchange-adapter.js'
import type { BinanceMarketClient } from './factory.js'
import { buildInstrumentRegistry } from './instrument.js'

const HOUR_MS = 3_600_000

/** Everything the adapter needs, all injectable so unit tests run offline (`10` §2). */
export interface BinanceAdapterDeps {
  /** ccxt-backed market/funding client (`./factory.ts`); a fake in tests. */
  readonly client: BinanceMarketClient
  /** Time + timers — the only clock the reload loop reads (`08` §5). */
  readonly clock: Clock
  /** Canonical names to exclude from the universe (`config.symbols.deny`, `10` §3). */
  readonly deny?: readonly string[]
}

/** ccxt reports funding as a fraction (`0.0001`); the engine speaks signed percent (`0.01`). */
function toSignedPercent(fundingRate: number | undefined): number {
  return (fundingRate ?? 0) * 100
}

/** Throw the uniform not-yet-built marker for a trade-side method (filled by 02xx). */
function notImplemented(method: string, task: string): never {
  throw new Error(`NotImplemented: BinanceAdapter.${method} — task ${task}`)
}

export function createBinanceAdapter(deps: BinanceAdapterDeps): ExchangeAdapter {
  const { client, clock } = deps
  const deny = deps.deny ?? []

  // Swapped atomically on every (re)load — readers never see a half-built registry.
  let instruments = new Map<string, Instrument>()
  let reloadHandle: TimerHandle | undefined

  /** Load + validate markets into a fresh registry, then swap the reference in. */
  async function reloadRegistry(): Promise<void> {
    const markets = await client.loadMarkets()
    instruments = buildInstrumentRegistry(Object.values(markets), deny)
  }

  /** Self-perpetuating hourly reload (mirrors `scheduler.ts:scheduleScan`). */
  function armReload(): void {
    reloadHandle = clock.scheduleTimer(clock.now() + HOUR_MS, () => {
      // Fire-and-forget: a transient reload failure keeps the last-good registry and
      // the next tick retries. Re-arm first so one rejected load never stops the loop.
      armReload()
      void reloadRegistry()
    })
  }

  /** Look up a validated instrument; fail loud on an unknown symbol (sim parity, `10` §4). */
  function normalize(symbol: string): Instrument {
    const instrument = instruments.get(symbol)
    if (!instrument) throw new Error(`BinanceAdapter: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Resolve a normalized symbol to its exact venue string for a REST call. */
  function venueSymbol(symbol: string): string {
    return normalize(symbol).venueSymbol
  }

  return {
    // ── lifecycle ─────────────────────────────────────────────────────────────
    async init(): Promise<void> {
      await reloadRegistry() // fail-loud: a bad instrument aborts startup (`10` §3)
      armReload()
    },
    close(): Promise<void> {
      reloadHandle?.cancel()
      reloadHandle = undefined
      return Promise.resolve()
    },

    // ── account setup (trade-side — 0240) ─────────────────────────────────────
    setLeverage(_symbol: string, _leverage: number): Promise<void> {
      return notImplemented('setLeverage', '0240')
    },
    setMarginMode(_symbol: string, _mode: MarginMode): Promise<void> {
      return notImplemented('setMarginMode', '0240')
    },
    setPositionMode(_mode: PositionMode): Promise<void> {
      return notImplemented('setPositionMode', '0240')
    },

    // ── market metadata (synchronous reads off the cached registry) ───────────
    markets(): Market[] {
      return [...instruments.values()].map((i) => ({
        normalized: i.normalized,
        venueSymbol: i.venueSymbol,
        status: 'trading',
      }))
    },
    normalize,

    // ── orders (native WS-first — 0230) ───────────────────────────────────────
    placeOrder(_req: OrderRequest): Promise<OrderAck> {
      return notImplemented('placeOrder', '0230')
    },
    cancelOrder(_clientOrderId: string): Promise<void> {
      return notImplemented('cancelOrder', '0230')
    },
    getOrder(_clientOrderId: string): Promise<Order> {
      return notImplemented('getOrder', '0230')
    },
    getPositions(): Promise<Position[]> {
      return notImplemented('getPositions', '0240')
    },
    getBalance(): Promise<Balance> {
      return notImplemented('getBalance', '0240')
    },

    // ── funding (ccxt REST) ───────────────────────────────────────────────────
    async predictedFunding(symbol: string): Promise<Rate> {
      const fr = await client.fetchFundingRate(venueSymbol(symbol))
      return { symbol, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() }
    },
    async fundingHistory(symbol: string, range: TimeRange): Promise<FundingEvent[]> {
      const rows = await client.fetchFundingRateHistory(venueSymbol(symbol), range.fromTs)
      return rows
        .filter((r) => r.timestamp !== undefined && r.timestamp >= range.fromTs && r.timestamp <= range.toTs)
        .map((r) => ({ symbol, rate: toSignedPercent(r.fundingRate), settleTs: r.timestamp as number }))
    },

    // ── streams (native WS — 0210 public / 0220 private) ──────────────────────
    streams: {
      public: {
        subscribe(_symbols: readonly string[]): Promise<void> {
          return notImplemented('streams.public.subscribe', '0210')
        },
        close(): Promise<void> {
          return notImplemented('streams.public.close', '0210')
        },
      },
      private: {
        subscribe(): Promise<void> {
          return notImplemented('streams.private.subscribe', '0220')
        },
        close(): Promise<void> {
          return notImplemented('streams.private.close', '0220')
        },
      },
    },
  } satisfies ExchangeAdapter
}
