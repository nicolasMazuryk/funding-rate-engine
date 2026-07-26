/**
 * Account-setup check (`17` §3 bullet 2, `11` §1). Applies one-way position mode, isolated
 * margin and leverage through the real adapter, then repeats each call — the adapter's
 * applied-state cache (`bitget/account-setup.ts`) must make the repeat a no-op (no throw) —
 * and finally **reads the account back natively** (`GET /api/v3/account/settings`) so a
 * silently-ignored write cannot pass.
 *
 * Bitget divergences (task 0440):
 *  - **margin mode is an account-level switch**, not a per-symbol one: the UTA `accountLevel`
 *    (`basic`/`advanced`/`isolated`/`delta`) is what decides isolation, written with
 *    `POST /api/v3/account/adjust-mode`. The port's `symbol` is ignored. The write **is**
 *    permitted on a demo sub-account (verified live in Phase 2), so a level that is still not
 *    `isolated` after the write is a **skip-with-reason** — the adapter deliberately swallows a
 *    refusal, and isolation is still enforced per order by `marginMode: 'isolated'` on submit.
 *  - **position mode is account-wide** (`POST /api/v3/account/set-hold-mode`) and Bitget refuses
 *    it while anything is open, so the adapter reads first and leaves a matching account alone.
 *  - **leverage is per symbol and carries the margin mode**, and the read-back is not a separate
 *    endpoint: the applied value shows up in the settings' `symbolConfigList` row for the
 *    symbol, scoped by the same `marginMode` the write used.
 */

import type { BitgetTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The only symbol this suite trades (order-path assumes this leverage is applied). */
const SYMBOL = 'BTC'
const LEVERAGE = 5

/** The UTA account level that trades isolated margin. */
const ISOLATED_ACCOUNT_LEVEL = 'isolated'
/** Bitget's one-way position mode. */
const ONE_WAY_MODE = 'one_way_mode'

export const accountSetupCheck: Check<BitgetTestnetContext> = {
  name: 'account-setup',
  specRef: '17 §3 account setup',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const venueSymbol = ctx.adapter.normalize(SYMBOL).venueSymbol

    await ctx.adapter.setPositionMode('one_way')
    await ctx.adapter.setMarginMode(SYMBOL, 'isolated')
    await ctx.adapter.setLeverage(SYMBOL, LEVERAGE)

    // Idempotency: a repeat apply with the same values must be a cached no-op, not a throw.
    await ctx.adapter.setPositionMode('one_way')
    await ctx.adapter.setMarginMode(SYMBOL, 'isolated')
    await ctx.adapter.setLeverage(SYMBOL, LEVERAGE)

    const settings = (await ctx.clients.native.getAccountSettings()).data
    const holdMode = settings?.holdMode
    if (holdMode !== ONE_WAY_MODE) {
      throw new Error(`account hold mode is '${String(holdMode)}', expected '${ONE_WAY_MODE}'`)
    }

    // Read-back 2: the applied leverage, scoped by the margin mode the write used.
    const symbolConfig = settings?.symbolConfigList?.find((c) => c.symbol === venueSymbol)
    if (symbolConfig === undefined) {
      throw new Error(`no symbolConfigList row for ${venueSymbol} after set-leverage — the write did not land`)
    }
    if (Number(symbolConfig.leverage) !== LEVERAGE) {
      throw new Error(`applied leverage on ${venueSymbol} is ${symbolConfig.leverage}, expected ${LEVERAGE}`)
    }
    if (symbolConfig.marginMode !== ISOLATED_ACCOUNT_LEVEL) {
      throw new Error(`per-symbol margin mode is '${symbolConfig.marginMode}', expected '${ISOLATED_ACCOUNT_LEVEL}'`)
    }

    const accountLevel = settings?.accountLevel
    const detail = {
      symbol: SYMBOL,
      holdMode,
      accountLevel,
      accountMode: settings?.accountMode,
      leverage: symbolConfig.leverage,
      marginMode: symbolConfig.marginMode,
    }
    if (accountLevel !== ISOLATED_ACCOUNT_LEVEL) {
      return {
        status: 'skip',
        reason: `account level is '${String(accountLevel)}' — adjust-mode was refused, so isolation rests entirely on the per-order marginMode:'isolated'`,
        detail,
      }
    }

    return { status: 'pass', detail }
  },
}
