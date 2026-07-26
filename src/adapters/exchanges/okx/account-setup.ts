/**
 * OKX account setup (`11_execution_and_account_state.md` §1) — one-way position mode,
 * isolated margin and per-symbol leverage, each applied **once in advance** behind an
 * applied-state cache, mirroring `../bybit/account-setup.ts`.
 *
 * Written against the native `RestClient`, not ccxt, for the same reason as the Bybit
 * sibling: ccxt's unified `setMarginMode` has no faithful OKX target (see below), and the
 * account-level read has no unified analogue at all.
 *
 * The three venue divergences, all settled against `GET /api/v5/account/config`:
 *  - **margin mode is not an account switch on OKX — it is a per-order field.** Isolation is
 *    requested with `tdMode: 'isolated'` on every submit (`./ws-orders.ts`), so
 *    `setMarginMode(symbol, 'isolated')` has no write of its own. What it *does* have is a
 *    precondition: an isolated **swap** order is only accepted on account level `2`
 *    (spot-and-futures). Level `1` cannot trade derivatives at all (`51010`) and levels `3`
 *    (multi-currency margin) / `4` (portfolio margin) reject `tdMode: 'isolated'`. So this
 *    method **checks `acctLv` and, when it is anything but `2`, asks for `2` via `POST
 *    /api/v5/account/set-account-level`**. That endpoint is privileged — an account that does
 *    not meet the venue's requirements is refused with `51070` and can only be upgraded in the
 *    OKX UI — so a failure is a **skip-with-reason**, logged and read back (the Bybit D1
 *    precedent) rather than a startup abort: the mandate is still enforced, one layer later and
 *    per order, by the venue rejecting the submit.
 *  - **position mode is account-wide** (`POST /api/v5/account/set-position-mode`,
 *    `posMode: 'net_mode'`) with no symbol or coin scope, so the port's account-wide shape
 *    maps 1:1. OKX rejects the call outright (`59000`) while any position or order is open —
 *    **even when the mode already matches** — so the current `posMode` is read first and a
 *    matching account is left alone. That read-then-write is what makes this survive a
 *    restart with a position on the book, where Bybit's "not modified" benign-code list is
 *    the equivalent trick.
 *  - **leverage is per symbol *and* per margin mode** (`POST /api/v5/account/set-leverage`
 *    takes `mgnMode`), unlike Bybit's buy/sell pair. `posSide` is omitted: it is only
 *    accepted in long/short mode, which `setPositionMode` has just ruled out.
 */

import type { MarginMode, PositionMode } from '../../../core/ports/exchange-adapter.js'

/**
 * The only account level under which an isolated-margin **swap** order is accepted. OKX's
 * levels are `1` spot-only (derivatives cannot be traded at all — the venue answers `51010`
 * "You can't complete this request under your current account mode", observed live on a fresh
 * demo account), `2` spot-and-futures, `3` multi-currency margin and `4` portfolio margin;
 * the last two reject `tdMode: 'isolated'`.
 */
const ISOLATED_CAPABLE_LEVELS = new Set(['2'])
/** The level requested from any other level — the one that trades isolated swaps. */
const TARGET_ACCOUNT_LEVEL = '2'
/** OKX's one-way position mode (`11` §1). */
const NET_MODE = 'net_mode'

/** The narrow native slice account setup drives (structurally satisfied by `RestClient`). */
export interface OkxAccountSetupClient {
  /** `GET /api/v5/account/config` — the current `acctLv` / `posMode`, read before any write. */
  getAccountConfiguration(): Promise<readonly { acctLv?: string; posMode?: string }[]>
  /** `POST /api/v5/account/set-position-mode` — account-wide; rejects while anything is open. */
  setPositionMode(params: { posMode: 'long_short_mode' | 'net_mode' }): Promise<unknown>
  /** `POST /api/v5/account/set-leverage` — per symbol **and** margin mode. */
  setLeverage(params: {
    instId?: string
    ccy?: string
    lever: string
    mgnMode: 'isolated' | 'cross'
    posSide?: 'long' | 'short'
  }): Promise<unknown>
  /**
   * `POST /api/v5/account/set-account-level` — the account-mode switch (the SDK spells it
   * `setAccountMode`; its `presetAccountLevelSwitch` is the *other* endpoint,
   * `/account-level-switch-preset`, which only pre-checks a switch made with open positions).
   * Privileged: an account that does not meet the venue's requirements is refused with
   * `51070` and must be upgraded in the OKX UI, so a failure is a skip, not an abort.
   */
  setAccountMode(params: { acctLv: '2' | '3' | '4' }): Promise<unknown>
}

export interface OkxAccountSetupDeps {
  readonly client: OkxAccountSetupClient
  /** Normalized → exact venue symbol (`BTC` → `BTC-USDT-SWAP`), an adapter registry read. */
  readonly resolveVenue: (symbol: string) => string
  /**
   * Optional general-lane wrapper (limiter + `mapOkxError`), mirroring the adapter's
   * `callGeneral`. Absent → the raw call runs (offline unit tests inject a fake client).
   */
  readonly call?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Structured-log callback; the account-level skip-with-reason lands here. No-op when absent. */
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void
}

/** The three account-setup operations, cached idempotent. Mirrors the port method names. */
export interface OkxAccountSetup {
  setLeverage(symbol: string, leverage: number): Promise<void>
  setMarginMode(symbol: string, mode: MarginMode): Promise<void>
  setPositionMode(mode: PositionMode): Promise<void>
}

export function createOkxAccountSetup(deps: OkxAccountSetupDeps): OkxAccountSetup {
  const { client, resolveVenue } = deps
  const call = deps.call ?? (<T>(fn: () => Promise<T>): Promise<T> => fn())
  const log = deps.log ?? ((): void => {})

  // Applied-state cache (`11` §1): once applied, a repeat with the same value is a no-op.
  const leverageBySymbol = new Map<string, number>()
  let appliedMarginMode: MarginMode | undefined
  let appliedPositionMode: PositionMode | undefined

  /** Read `GET /api/v5/account/config` (single-row array); `{}` when the venue returns none. */
  async function readConfig(): Promise<{ acctLv?: string; posMode?: string }> {
    const rows = await call(() => client.getAccountConfiguration())
    return rows[0] ?? {}
  }

  return {
    async setLeverage(symbol: string, leverage: number): Promise<void> {
      if (leverageBySymbol.get(symbol) === leverage) return
      // `mgnMode` is required and scopes the value; `posSide` is omitted (net mode only).
      await call(() =>
        client.setLeverage({ instId: resolveVenue(symbol), lever: String(leverage), mgnMode: 'isolated' }),
      )
      leverageBySymbol.set(symbol, leverage)
    },

    /**
     * No write of its own — isolation is per order (`tdMode`). This asserts the *precondition*:
     * an account on level 3/4 cannot send `tdMode: 'isolated'` at all, so ask for level 2 and,
     * if the venue refuses (privileged on a sub-account), record the skip and read the level
     * back so the testnet tier can report what the account actually is (`17` §3).
     * `symbol` is accepted for port parity and deliberately unused.
     */
    async setMarginMode(_symbol: string, mode: MarginMode): Promise<void> {
      if (appliedMarginMode === mode) return
      const { acctLv } = await readConfig()
      if (acctLv === undefined || !ISOLATED_CAPABLE_LEVELS.has(acctLv)) {
        try {
          await call(() => client.setAccountMode({ acctLv: TARGET_ACCOUNT_LEVEL }))
        } catch (err) {
          const readBack = await readConfig().catch(() => ({ acctLv: undefined }))
          log('okx: account-level switch skipped — isolated margin rests on the per-order tdMode', {
            requested: TARGET_ACCOUNT_LEVEL,
            acctLv: readBack.acctLv ?? acctLv,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
      appliedMarginMode = mode
    },

    /**
     * One-way (`net_mode`), account-wide. Read first: OKX rejects the write with `59000`
     * whenever a position or order is open, including the no-op case where the account is
     * already in the mode being requested.
     */
    async setPositionMode(mode: PositionMode): Promise<void> {
      if (appliedPositionMode === mode) return
      const { posMode } = await readConfig()
      if (posMode !== NET_MODE) await call(() => client.setPositionMode({ posMode: NET_MODE }))
      appliedPositionMode = mode
    },
  }
}
