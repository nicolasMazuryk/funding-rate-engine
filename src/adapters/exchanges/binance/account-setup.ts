/**
 * Binance account setup (`11_execution_and_account_state.md` §1) — the venue-specific
 * half. Applies one-way position mode, isolated margin, and per-symbol leverage via the
 * ccxt client, each **once in advance** with an **applied-state cache** so a repeat call
 * is a no-op ("adapter records applied state", `11` §1). Effective leverage (per-exchange
 * delta, `00_globals` §6) is resolved by config (0110) and passed in as a plain number;
 * this layer consumes it, it does not re-derive the delta.
 *
 * Backs the adapter's three port methods. The venue-neutral orchestration + readiness
 * (`runAccountSetup`, hard-reject-on-throw) lives in `src/execution/account-setup.ts`.
 *
 * ccxt signatures (Context7-verified against `binanceusdm`):
 *   `setLeverage(leverage, symbol, params)`,
 *   `setMarginMode('isolated', symbol, params)`,
 *   `setPositionMode(hedged, symbol?, params)` — one-way is `hedged: false`, account-wide.
 */

import type { MarginMode, PositionMode } from '../../../core/ports/exchange-adapter.js'

/** The narrow ccxt slice account setup drives (structurally satisfied by `binanceusdm`). */
export interface BinanceAccountSetupClient {
  setLeverage(leverage: number, symbol?: string, params?: Record<string, unknown>): Promise<unknown>
  setMarginMode(marginMode: string, symbol?: string, params?: Record<string, unknown>): Promise<unknown>
  setPositionMode(hedged: boolean, symbol?: string, params?: Record<string, unknown>): Promise<unknown>
}

export interface BinanceAccountSetupDeps {
  readonly client: BinanceAccountSetupClient
  /** Normalized → exact venue symbol for the API call (adapter registry read). */
  readonly resolveVenue: (symbol: string) => string
  /**
   * Optional general-lane wrapper (limiter + `mapBinanceError`), mirroring the adapter's
   * `callGeneral`. Absent → the raw call runs (offline unit tests inject a fake client).
   */
  readonly call?: <T>(fn: () => Promise<T>) => Promise<T>
}

/** The three account-setup operations, cached idempotent. Mirrors the port method names. */
export interface BinanceAccountSetup {
  setLeverage(symbol: string, leverage: number): Promise<void>
  setMarginMode(symbol: string, mode: MarginMode): Promise<void>
  setPositionMode(mode: PositionMode): Promise<void>
}

/**
 * Binance answers a redundant setting change with a `"No need to change …"` error whose
 * value is already the desired end-state, not a failure — treat it as applied. This backs
 * the applied-state cache across **process restarts**: the cache only suppresses repeats
 * within one process, but the account may already carry the setting from a prior run.
 *   - margin mode → `-4046 "No need to change margin type."`
 *   - position mode → `-4059 "No need to change position side."`
 */
function isBenignNoChange(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('-4046') || msg.includes('-4059') || /no need to change/i.test(msg)
}

export function createBinanceAccountSetup(deps: BinanceAccountSetupDeps): BinanceAccountSetup {
  const { client, resolveVenue } = deps
  const call = deps.call ?? (<T>(fn: () => Promise<T>): Promise<T> => fn())

  // Applied-state cache (`11` §1): once applied, a repeat with the same value is a no-op.
  const leverageBySymbol = new Map<string, number>()
  const marginBySymbol = new Map<string, MarginMode>()
  let appliedPositionMode: PositionMode | undefined

  return {
    async setLeverage(symbol: string, leverage: number): Promise<void> {
      if (leverageBySymbol.get(symbol) === leverage) return
      await call(() => client.setLeverage(leverage, resolveVenue(symbol)))
      leverageBySymbol.set(symbol, leverage)
    },

    async setMarginMode(symbol: string, mode: MarginMode): Promise<void> {
      if (marginBySymbol.get(symbol) === mode) return
      try {
        await call(() => client.setMarginMode(mode, resolveVenue(symbol)))
      } catch (err) {
        if (!isBenignNoChange(err)) throw err
      }
      marginBySymbol.set(symbol, mode)
    },

    async setPositionMode(mode: PositionMode): Promise<void> {
      if (appliedPositionMode === mode) return
      // One-way ⇒ hedged:false; account-wide, so no symbol argument.
      try {
        await call(() => client.setPositionMode(mode !== 'one_way'))
      } catch (err) {
        if (!isBenignNoChange(err)) throw err
      }
      appliedPositionMode = mode
    },
  }
}
