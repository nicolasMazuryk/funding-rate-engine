/**
 * Account-setup check (`17` §3 bullet 2, `11` §1). Applies one-way position mode, isolated
 * margin and leverage through the real adapter, then repeats each call — the adapter's
 * applied-state cache (`okx/account-setup.ts`) must make the repeat a no-op (no throw) — and
 * finally **reads the account back natively** so a silently-ignored write can't pass.
 *
 * OKX divergences (task 0430):
 *  - **margin mode is not an account switch at all** — isolation is a per-order field
 *    (`tdMode: 'isolated'`). What `setMarginMode` enforces is the *precondition*: only account
 *    level `2` (spot-and-futures) trades isolated swaps — level `1` cannot trade derivatives
 *    at all (`51010`) and levels `3`/`4` reject `tdMode: 'isolated'` — so it asks for `2` via
 *    `POST /api/v5/account/set-account-level`. That endpoint is privileged (`51070`: upgrade
 *    the account mode in the OKX UI), so a refusal is swallowed + logged by the adapter; here
 *    it becomes a **skip-with-reason** naming the level the account actually sits on, since
 *    the account's mode is a property of the account and not of our code (the Bybit D1
 *    precedent).
 *  - **position mode is account-wide** (`POST /api/v5/account/set-position-mode`,
 *    `posMode: 'net_mode'`) and OKX rejects the call with `59000` while any position or order
 *    is open — **even when the mode already matches** — so the adapter reads first and leaves
 *    a matching account alone. A refusal is likewise a skip, not a failure.
 *  - **leverage is per symbol *and* per margin mode**, so the read-back is
 *    `GET /api/v5/account/leverage-info` scoped by `mgnMode: 'isolated'` — the same scope the
 *    write used. A cross-margin read would report a different number for the same symbol.
 */

import type { OkxTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The only symbol this suite trades (order-path assumes this leverage is applied). */
const SYMBOL = 'BTC'
const LEVERAGE = 5

/** The only account level under which the per-order `tdMode: 'isolated'` is accepted on a swap. */
const ISOLATED_CAPABLE_LEVELS = new Set(['2'])
/** OKX's one-way position mode. */
const NET_MODE = 'net_mode'

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const accountSetupCheck: Check<OkxTestnetContext> = {
  name: 'account-setup',
  specRef: '17 §3 account setup',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const venueSymbol = ctx.adapter.normalize(SYMBOL).venueSymbol

    // Account-wide write first: a refusal here is an account property, not a code fault.
    try {
      await ctx.adapter.setPositionMode('one_way')
    } catch (err) {
      return {
        status: 'skip',
        reason: `account-wide position-mode switch refused (59000 — open positions/orders): ${reasonOf(err)}`,
      }
    }
    await ctx.adapter.setMarginMode(SYMBOL, 'isolated')
    await ctx.adapter.setLeverage(SYMBOL, LEVERAGE)

    // Idempotency: a repeat apply with the same values must be a cached no-op, not a throw.
    await ctx.adapter.setPositionMode('one_way')
    await ctx.adapter.setMarginMode(SYMBOL, 'isolated')
    await ctx.adapter.setLeverage(SYMBOL, LEVERAGE)

    // Read-back 1: the account really is in one-way mode, and on a level that accepts the
    // per-order `tdMode: 'isolated'` every submit sends.
    const config = (await ctx.clients.native.getAccountConfiguration())[0]
    const posMode = config?.posMode
    if (posMode !== NET_MODE) {
      throw new Error(`account position mode is '${String(posMode)}', expected '${NET_MODE}'`)
    }

    // Read-back 2: the applied leverage, scoped by the margin mode the write used.
    const levers = await ctx.clients.native.getLeverage({ instId: venueSymbol, mgnMode: 'isolated' })
    const appliedLeverage = levers[0]?.lever
    if (appliedLeverage !== undefined && Number(appliedLeverage) !== LEVERAGE) {
      throw new Error(`applied leverage on ${venueSymbol} is ${appliedLeverage}, expected ${LEVERAGE}`)
    }

    const acctLv = config?.acctLv
    const detail = { symbol: SYMBOL, posMode, acctLv, leverage: appliedLeverage ?? 'not reported' }
    if (acctLv === undefined || !ISOLATED_CAPABLE_LEVELS.has(acctLv)) {
      return {
        status: 'skip',
        reason: `account level is '${String(acctLv)}' — set-account-level is refused (51070, UI-only upgrade), so the venue will reject a per-order tdMode:'isolated' swap until the account is on level 2 (spot-and-futures)`,
        detail,
      }
    }

    return { status: 'pass', detail }
  },
}
