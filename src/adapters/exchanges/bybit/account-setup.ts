/**
 * Bybit account setup (`11_execution_and_account_state.md` §1) — the venue-specific half,
 * mirroring `../binance/account-setup.ts`: one-way position mode, isolated margin, and
 * per-symbol leverage, each applied **once in advance** with an **applied-state cache** so
 * a repeat call is a no-op ("adapter records applied state", `11` §1).
 *
 * Venue quirks (task 0420 decision D1 — target the Unified Trading Account, since classic
 * is legacy). Written against the native `RestClientV5`, not ccxt, because ccxt's unified
 * `setMarginMode` maps to the *classic* per-symbol isolated switch:
 *  - **margin mode is account-level on UTA** (`POST /v5/account/set-margin-mode`): there is
 *    no per-symbol isolated switch as on Binance. `setMarginMode(symbol, 'isolated')`
 *    therefore maps to the account-wide `ISOLATED_MARGIN` call, **ignores `symbol`**, and is
 *    cached so it is applied once per process — one call instead of N, preserving the `11` §1
 *    isolated-margin *intent* rather than silently degrading to cross;
 *  - **position mode is per symbol or per coin** (`POST /v5/position/switch-mode`); the port
 *    method is account-wide, so we pass `coin: 'USDT'` — one call covering the whole linear
 *    USDT universe, matching the port's shape;
 *  - **leverage requires `buyLeverage === sellLeverage`** in one-way mode
 *    (`POST /v5/position/set-leverage`), so both fields carry the same value.
 */

import type { MarginMode, PositionMode } from '../../../core/ports/exchange-adapter.js'

/** Settle coin of the linear USDT-perp universe — the `switch-mode` scope (`10` §3). */
const SETTLE_COIN = 'USDT'

/** The narrow native slice account setup drives (structurally satisfied by `RestClientV5`). */
export interface BybitAccountSetupClient {
  /** `POST /v5/position/set-leverage` — per symbol; one-way requires buy === sell. */
  setLeverage(params: {
    category: 'linear' | 'inverse'
    symbol: string
    buyLeverage: string
    sellLeverage: string
  }): Promise<unknown>
  /** `POST /v5/account/set-margin-mode` — **account-wide** on UTA (D1). */
  setMarginMode(marginMode: 'ISOLATED_MARGIN' | 'REGULAR_MARGIN' | 'PORTFOLIO_MARGIN'): Promise<unknown>
  /** `POST /v5/position/switch-mode` — `mode: 0` = one-way; scoped by `symbol` or `coin`. */
  switchPositionMode(params: {
    category: 'linear' | 'inverse'
    symbol?: string
    coin?: string
    mode: 0 | 3
  }): Promise<unknown>
}

export interface BybitAccountSetupDeps {
  readonly client: BybitAccountSetupClient
  /** Normalized → exact venue symbol for the API call (adapter registry read). */
  readonly resolveVenue: (symbol: string) => string
  /**
   * Optional general-lane wrapper (limiter + `mapBybitError`), mirroring the adapter's
   * `callGeneral`. Absent → the raw call runs (offline unit tests inject a fake client).
   */
  readonly call?: <T>(fn: () => Promise<T>) => Promise<T>
}

/** The three account-setup operations, cached idempotent. Mirrors the port method names. */
export interface BybitAccountSetup {
  setLeverage(symbol: string, leverage: number): Promise<void>
  setMarginMode(symbol: string, mode: MarginMode): Promise<void>
  setPositionMode(mode: PositionMode): Promise<void>
}

/**
 * Bybit answers a redundant setting change with an error whose value is already the desired
 * end-state, not a failure — the analogue of Binance's `-4046`/`-4059`. Treat it as applied:
 * this is what makes the applied-state cache survive **process restarts** (the cache only
 * suppresses repeats within one process, but the account may already carry the setting).
 *   - `110043` leverage not modified
 *   - `110025` position mode not modified
 *   - `110026` cross/isolated margin mode not modified
 */
const NO_CHANGE_CODES = new Set([110043, 110025, 110026])

function isBenignNoChange(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    // `rawCode` when the error came through `mapBybitError`; `retCode` when the native lib
    // threw the raw response body (no wrapper, e.g. the offline unit tests).
    const { rawCode, retCode, retMsg } = err as { rawCode?: unknown; retCode?: unknown; retMsg?: unknown }
    for (const code of [rawCode, retCode]) {
      if (typeof code === 'number' && NO_CHANGE_CODES.has(code)) return true
    }
    if (typeof retMsg === 'string' && /not modified/i.test(retMsg)) return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return /110043|110025|110026/.test(msg) || /not modified/i.test(msg)
}

export function createBybitAccountSetup(deps: BybitAccountSetupDeps): BybitAccountSetup {
  const { client, resolveVenue } = deps
  const call = deps.call ?? (<T>(fn: () => Promise<T>): Promise<T> => fn())

  // Applied-state cache (`11` §1): once applied, a repeat with the same value is a no-op.
  const leverageBySymbol = new Map<string, number>()
  let appliedMarginMode: MarginMode | undefined
  let appliedPositionMode: PositionMode | undefined

  return {
    async setLeverage(symbol: string, leverage: number): Promise<void> {
      if (leverageBySymbol.get(symbol) === leverage) return
      const value = String(leverage)
      try {
        await call(() =>
          client.setLeverage({
            category: 'linear',
            symbol: resolveVenue(symbol),
            buyLeverage: value,
            sellLeverage: value,
          }),
        )
      } catch (err) {
        if (!isBenignNoChange(err)) throw err
      }
      leverageBySymbol.set(symbol, leverage)
    },

    /** Account-wide on UTA (D1) — `symbol` is accepted for port parity and deliberately unused. */
    async setMarginMode(_symbol: string, mode: MarginMode): Promise<void> {
      if (appliedMarginMode === mode) return
      try {
        await call(() => client.setMarginMode('ISOLATED_MARGIN'))
      } catch (err) {
        if (!isBenignNoChange(err)) throw err
      }
      appliedMarginMode = mode
    },

    async setPositionMode(mode: PositionMode): Promise<void> {
      if (appliedPositionMode === mode) return
      // One-way ⇒ `mode: 0`; scoped by settle coin so one call covers the USDT universe.
      try {
        await call(() => client.switchPositionMode({ category: 'linear', coin: SETTLE_COIN, mode: 0 }))
      } catch (err) {
        if (!isBenignNoChange(err)) throw err
      }
      appliedPositionMode = mode
    },
  }
}
