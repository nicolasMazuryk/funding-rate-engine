/**
 * KuCoin account setup (`11_execution_and_account_state.md` §1) — one-way position mode,
 * isolated margin and per-symbol leverage, each applied **once in advance** behind an
 * applied-state cache, mirroring `../bitget/account-setup.ts`.
 *
 * ⚠️ **Never exercised against the venue.** Every sibling adapter's account-setup path is proven
 * by its testnet tier; KuCoin has no sandbox, and this venue's tier is deliberately **read-only**
 * (`src/testnet/kucoin/registry.ts` ships no `accountSetup` check, because running one would
 * mutate a live account's margin/position mode). So this file is written from the venue's own API
 * reference and typechecked against the native SDK, and nothing more. Treat the first live run as
 * the verification step, and do not let tasks 0470/0480 assume it has already happened.
 *
 * Written against the native `FuturesClient`, not ccxt, for the usual `08` §6 reason: ccxt's
 * unified helpers do not cover the venue's own account-level reads used here.
 *
 * The three venue divergences:
 *
 *  - **margin mode is per symbol** (`POST /api/v1/position/changeMarginMode`, via the SDK's
 *    `updateMarginMode({ symbol, marginMode: 'ISOLATED' })`), like Binance and unlike
 *    Bybit/OKX/Bitget's account-level switches. The current mode is read first
 *    (`getMarginMode`) so a symbol already isolated is left alone. A refusal is a
 *    **skip-with-reason, logged** rather than a startup abort — the mandate is still enforced one
 *    layer later, per order, by `marginMode: 'ISOLATED'` on every submit (`./ws-orders.ts`).
 *
 *  - **position mode is account-wide and numeric**: `updatePositionMode({ positionMode: '0' })`,
 *    where `'0'` is one-way and `'1'` is hedge. Read first and a matching account left alone: the
 *    venue rejects the switch while anything is open, so a restart with a position on the book
 *    must not re-issue it (OKX's `59000` lesson, same fix).
 *
 *  - **isolated leverage has no endpoint at all** — the sharpest divergence of the five venues.
 *    KuCoin publishes `getCrossMarginLeverage` / `changeCrossMarginLeverage` and *nothing* for
 *    isolated margin, because on this venue **isolated leverage is an order parameter**: the
 *    submit payload carries `leverage`. So `setLeverage` here does not call the venue at all —
 *    it records the value, and `./adapter.ts` threads it into the order transport, which puts it
 *    on every submit. That keeps the port's "set once in advance" contract honest (the value is
 *    fixed before any order) while matching how the venue actually applies it.
 */

import type { MarginMode, PositionMode } from '../../../core/ports/exchange-adapter.js'

/** The margin mode the mandate requires (`11` §1) — upper case on this venue. */
const ISOLATED = 'ISOLATED' as const
/** KuCoin's one-way position mode; `'1'` is hedge mode. */
const ONE_WAY_MODE = '0' as const

/** The narrow native slice account setup drives (structurally satisfied by `FuturesClient`). */
export interface KucoinAccountSetupClient {
  /** Current margin mode for one symbol, read before any write. */
  getMarginMode(params: { symbol: string }): Promise<{ data?: { marginMode?: string } }>
  /** Per-symbol margin-mode switch; refused while that symbol has an open position/order. */
  updateMarginMode(params: { symbol: string; marginMode: 'ISOLATED' | 'CROSS' }): Promise<unknown>
  /** Account-wide position mode, read before any write. */
  getPositionMode(): Promise<{ data?: { positionMode?: string | number } }>
  /** Account-wide position-mode switch; rejects while anything is open. */
  updatePositionMode(params: { positionMode: '0' | '1' }): Promise<unknown>
}

export interface KucoinAccountSetupDeps {
  readonly client: KucoinAccountSetupClient
  /** Normalized → exact venue symbol (`BTC` → `XBTUSDTM`), an adapter registry read. */
  readonly resolveVenue: (symbol: string) => string
  /**
   * Optional general-lane wrapper (limiter + `mapKucoinError`), mirroring the adapter's
   * `callGeneral`. Absent → the raw call runs (offline unit tests inject a fake client).
   */
  readonly call?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Structured-log callback; the margin-mode skip-with-reason lands here. No-op when absent. */
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * The three account-setup operations, cached idempotent, plus the leverage read the order
 * transport needs (see the file header: on KuCoin, isolated leverage rides the order).
 */
export interface KucoinAccountSetup {
  setLeverage(symbol: string, leverage: number): Promise<void>
  setMarginMode(symbol: string, mode: MarginMode): Promise<void>
  setPositionMode(mode: PositionMode): Promise<void>
  /** The leverage recorded for a canonical symbol, or `undefined` if none was ever set. */
  leverageFor(symbol: string): number | undefined
}

export function createKucoinAccountSetup(deps: KucoinAccountSetupDeps): KucoinAccountSetup {
  const { client, resolveVenue } = deps
  const call = deps.call ?? (<T>(fn: () => Promise<T>): Promise<T> => fn())
  const log = deps.log ?? ((): void => {})

  // Applied-state cache (`11` §1): once applied, a repeat with the same value is a no-op.
  const leverageBySymbol = new Map<string, number>()
  const appliedMarginMode = new Map<string, MarginMode>()
  let appliedPositionMode: PositionMode | undefined

  return {
    /**
     * Records the leverage; issues no venue call. KuCoin has no isolated-leverage endpoint — the
     * value travels on every submit instead (file header). Still cached and still "set once in
     * advance", so the port's contract holds.
     */
    setLeverage(symbol: string, leverage: number): Promise<void> {
      leverageBySymbol.set(symbol, leverage)
      return Promise.resolve()
    },

    leverageFor(symbol: string): number | undefined {
      return leverageBySymbol.get(symbol)
    },

    /**
     * Per symbol — see the file header. Read the mode first, ask for `ISOLATED` when it is
     * anything else, and on refusal record the skip: the mandate is re-stated per order, so a
     * refused switch degrades rather than aborting startup.
     */
    async setMarginMode(symbol: string, mode: MarginMode): Promise<void> {
      if (appliedMarginMode.get(symbol) === mode) return
      const venue = resolveVenue(symbol)
      const current = (await call(() => client.getMarginMode({ symbol: venue }))).data?.marginMode
      if (current !== ISOLATED) {
        try {
          await call(() => client.updateMarginMode({ symbol: venue, marginMode: ISOLATED }))
        } catch (err) {
          log('kucoin: margin-mode switch skipped — isolated margin rests on the per-order marginMode', {
            symbol: venue,
            current,
            requested: ISOLATED,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
      appliedMarginMode.set(symbol, mode)
    },

    /**
     * One-way (`positionMode: '0'`), account-wide. Read first: KuCoin rejects the write whenever
     * a position or order is open, including the no-op case where the account already holds the
     * mode being requested.
     */
    async setPositionMode(mode: PositionMode): Promise<void> {
      if (appliedPositionMode === mode) return
      const current = (await call(() => client.getPositionMode())).data?.positionMode
      if (String(current) !== ONE_WAY_MODE) await call(() => client.updatePositionMode({ positionMode: ONE_WAY_MODE }))
      appliedPositionMode = mode
    },
  }
}
