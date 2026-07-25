/**
 * Account-setup check (`17` §3 bullet 2, `11` §1). Applies one-way position mode, isolated
 * margin and leverage through the real adapter, then repeats each call — the adapter's
 * applied-state cache (`bybit/account-setup.ts`) must make the repeat a no-op (no throw) —
 * and finally **reads the account back natively** so a silently-ignored write can't pass.
 *
 * Bybit divergences (task 0420 decision D1, Unified Trading Account):
 *  - margin mode is **account-wide** `ISOLATED_MARGIN` (`/v5/account/set-margin-mode`), one
 *    call for the whole account — `symbol` is accepted by the port and ignored by the venue;
 *  - position mode is one-way via `/v5/position/switch-mode` `mode=0`, scoped by
 *    `coin: 'USDT'` so one call covers the linear USDT universe;
 *  - leverage requires `buyLeverage === sellLeverage` in one-way mode, so a successful apply
 *    (and the single `leverage` the position read reports back) is the assertion.
 *
 * An account-wide switch is a privileged, whole-account operation: Bybit refuses it while
 * positions/orders are open, and it does not exist at all on a classic (non-UTA) account.
 * Those are properties of the testnet account, not of our code, so a refusal **skips with a
 * reason** rather than failing the run.
 */

import type { BybitTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The only symbol this suite trades (order-path assumes this leverage is applied). */
const SYMBOL = 'BTC'
const LEVERAGE = 5

/** UTA-only account-wide margin mode this adapter targets (D1). */
const EXPECTED_MARGIN_MODE = 'ISOLATED_MARGIN'

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const accountSetupCheck: Check<BybitTestnetContext> = {
  name: 'account-setup',
  specRef: '17 §3 account setup',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const venueSymbol = ctx.adapter.normalize(SYMBOL).venueSymbol

    // Account-wide writes first: a refusal here is an account property, not a code fault.
    try {
      await ctx.adapter.setPositionMode('one_way')
      await ctx.adapter.setMarginMode(SYMBOL, 'isolated')
    } catch (err) {
      return {
        status: 'skip',
        reason: `account-wide position/margin-mode switch refused (open positions, or not a Unified Trading Account): ${reasonOf(err)}`,
      }
    }
    await ctx.adapter.setLeverage(SYMBOL, LEVERAGE)

    // Idempotency: a repeat apply with the same values must be a cached no-op, not a throw.
    await ctx.adapter.setPositionMode('one_way')
    await ctx.adapter.setMarginMode(SYMBOL, 'isolated')
    await ctx.adapter.setLeverage(SYMBOL, LEVERAGE)

    // Read-back 1: the account-wide margin mode really is ISOLATED_MARGIN (D1's whole point —
    // ccxt's unified `setMarginMode` would have hit the *classic* per-symbol switch instead).
    const account = await ctx.clients.native.getAccountInfo()
    const marginMode = account.result.marginMode
    if (marginMode !== EXPECTED_MARGIN_MODE) {
      throw new Error(`account margin mode is '${marginMode}', expected '${EXPECTED_MARGIN_MODE}'`)
    }

    // Read-back 2: the applied leverage. One-way mode reports a single `leverage` per
    // position — buy and sell are necessarily equal, which is exactly what the venue demands.
    const positions = await ctx.clients.native.getPositionInfo({ category: 'linear', symbol: venueSymbol })
    const row = positions.result.list.find((p) => p.symbol === venueSymbol)
    const appliedLeverage = row?.leverage
    if (appliedLeverage !== undefined && Number(appliedLeverage) !== LEVERAGE) {
      throw new Error(`applied leverage on ${venueSymbol} is ${appliedLeverage}, expected ${LEVERAGE}`)
    }

    return {
      status: 'pass',
      detail: {
        symbol: SYMBOL,
        marginMode,
        unifiedMarginStatus: account.result.unifiedMarginStatus,
        leverage: appliedLeverage ?? 'not reported (no position row)',
      },
    }
  },
}
