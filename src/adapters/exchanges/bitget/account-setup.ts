/**
 * Bitget account setup (`11_execution_and_account_state.md` §1) — one-way position mode,
 * isolated margin and per-symbol leverage, each applied **once in advance** behind an
 * applied-state cache, mirroring `../okx/account-setup.ts`.
 *
 * Written against the native `RestClientV3`, not ccxt, and this venue is the clearest case for
 * that split yet: ccxt's unified `setMarginMode` has **no UTA branch at all** — it routes
 * unconditionally to `POST /api/v2/mix/account/setMarginMode`, a v2 *mix* endpoint that does
 * not govern a unified account. Sending it would either fail on permissions or, worse, succeed
 * against the classic account while the UTA one stays cross-margined.
 *
 * The three venue divergences, all settled against `GET /api/v3/account/settings`:
 *  - **margin mode is an account-level switch, not a per-symbol one.** On UTA the account
 *    carries an `accountLevel` — `basic` / `advanced` / `isolated` / `delta` — and isolated
 *    margin is the `isolated` level, set with `POST /api/v3/account/adjust-mode`. The port's
 *    `symbol` is therefore ignored and the call is applied once per process, exactly like
 *    Bybit's account-wide `ISOLATED_MARGIN` (0420 D1). The switch can be refused (open
 *    positions, or a sub-account without the permission), so a failure is a **skip-with-reason,
 *    logged and read back** rather than a startup abort — the mandate is still enforced one
 *    layer later, per order, by `marginMode: 'isolated'` on every submit (`./ws-orders.ts`).
 *  - **position mode is account-wide** (`POST /api/v3/account/set-hold-mode`,
 *    `holdMode: 'one_way_mode'`) with no symbol or coin scope, so the port's account-wide shape
 *    maps 1:1. The current `holdMode` is read first and a matching account left alone: the
 *    venue rejects the write while anything is open, so a restart with a position on the book
 *    must not re-issue it (OKX's `59000` lesson, same fix).
 *  - **leverage is per symbol *and* carries the margin mode** (`POST /api/v3/account/set-leverage`
 *    takes `marginMode` alongside `leverage`), unlike Bybit's buy/sell pair. `posSide` is
 *    omitted: it only applies in hedge mode, which `setPositionMode` has just ruled out.
 */

import type { MarginMode, PositionMode } from '../../../core/ports/exchange-adapter.js'

/** The UTA account level that trades isolated margin; anything else needs the switch. */
const ISOLATED_ACCOUNT_LEVEL = 'isolated'
/** Bitget's one-way position mode (`11` §1). */
const ONE_WAY_MODE = 'one_way_mode'
/** The linear-USDT category on every UTA account write. */
const CATEGORY = 'USDT-FUTURES'

/** The narrow native slice account setup drives (structurally satisfied by `RestClientV3`). */
export interface BitgetAccountSetupClient {
  /** `GET /api/v3/account/settings` — the current `accountLevel` / `holdMode`, read before any write. */
  getAccountSettings(): Promise<{ data?: { accountLevel?: string; holdMode?: string } }>
  /** `POST /api/v3/account/adjust-mode` — the account-level switch (privileged; may be refused). */
  adjustAccountMode(params: { mode: 'basic' | 'advanced' | 'delta' | 'isolated' }): Promise<unknown>
  /** `POST /api/v3/account/set-hold-mode` — account-wide; rejects while anything is open. */
  setHoldMode(params: { holdMode: 'one_way_mode' | 'hedge_mode' }): Promise<unknown>
  /** `POST /api/v3/account/set-leverage` — per symbol, and scoped by margin mode. */
  setLeverage(params: {
    category: string
    symbol?: string
    leverage: string
    marginMode?: 'crossed' | 'isolated'
  }): Promise<unknown>
}

export interface BitgetAccountSetupDeps {
  readonly client: BitgetAccountSetupClient
  /** Normalized → exact venue symbol (`BTC` → `BTCUSDT`), an adapter registry read. */
  readonly resolveVenue: (symbol: string) => string
  /**
   * Optional general-lane wrapper (limiter + `mapBitgetError`), mirroring the adapter's
   * `callGeneral`. Absent → the raw call runs (offline unit tests inject a fake client).
   */
  readonly call?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Structured-log callback; the account-level skip-with-reason lands here. No-op when absent. */
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void
}

/** The three account-setup operations, cached idempotent. Mirrors the port method names. */
export interface BitgetAccountSetup {
  setLeverage(symbol: string, leverage: number): Promise<void>
  setMarginMode(symbol: string, mode: MarginMode): Promise<void>
  setPositionMode(mode: PositionMode): Promise<void>
}

export function createBitgetAccountSetup(deps: BitgetAccountSetupDeps): BitgetAccountSetup {
  const { client, resolveVenue } = deps
  const call = deps.call ?? (<T>(fn: () => Promise<T>): Promise<T> => fn())
  const log = deps.log ?? ((): void => {})

  // Applied-state cache (`11` §1): once applied, a repeat with the same value is a no-op.
  const leverageBySymbol = new Map<string, number>()
  let appliedMarginMode: MarginMode | undefined
  let appliedPositionMode: PositionMode | undefined

  /** Read `GET /api/v3/account/settings`; `{}` when the venue returns no payload. */
  async function readSettings(): Promise<{ accountLevel?: string; holdMode?: string }> {
    const res = await call(() => client.getAccountSettings())
    return res.data ?? {}
  }

  return {
    async setLeverage(symbol: string, leverage: number): Promise<void> {
      if (leverageBySymbol.get(symbol) === leverage) return
      // `marginMode` scopes the value and `posSide` is omitted (one-way mode only).
      await call(() =>
        client.setLeverage({
          category: CATEGORY,
          symbol: resolveVenue(symbol),
          leverage: String(leverage),
          marginMode: 'isolated',
        }),
      )
      leverageBySymbol.set(symbol, leverage)
    },

    /**
     * Account-wide, not per symbol — see the file header. Read the level first, ask for
     * `isolated` when it is anything else, and on refusal record the skip **and read the level
     * back**, so a silently-ignored write cannot pass for a successful one (`17` §3, the Bybit
     * D1 precedent). `symbol` is accepted for port parity and deliberately unused.
     */
    async setMarginMode(_symbol: string, mode: MarginMode): Promise<void> {
      if (appliedMarginMode === mode) return
      const { accountLevel } = await readSettings()
      if (accountLevel !== ISOLATED_ACCOUNT_LEVEL) {
        try {
          await call(() => client.adjustAccountMode({ mode: ISOLATED_ACCOUNT_LEVEL }))
        } catch (err) {
          const readBack = await readSettings().catch(() => ({ accountLevel: undefined }))
          log('bitget: account-level switch skipped — isolated margin rests on the per-order marginMode', {
            requested: ISOLATED_ACCOUNT_LEVEL,
            accountLevel: readBack.accountLevel ?? accountLevel,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
      appliedMarginMode = mode
    },

    /**
     * One-way (`one_way_mode`), account-wide. Read first: Bitget rejects the write whenever a
     * position or order is open, including the no-op case where the account already holds the
     * mode being requested.
     */
    async setPositionMode(mode: PositionMode): Promise<void> {
      if (appliedPositionMode === mode) return
      const { holdMode } = await readSettings()
      if (holdMode !== ONE_WAY_MODE) await call(() => client.setHoldMode({ holdMode: ONE_WAY_MODE }))
      appliedPositionMode = mode
    },
  }
}
