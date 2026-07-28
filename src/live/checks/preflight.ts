/**
 * `subaccount-preflight` — the first check of every live suite (task 0470 phase 4).
 *
 * Proves the credentials point at the tiny, empty, one-way sub-account the tier is allowed to
 * trade *before* a single order exists (`../preflight.ts` for what "wrong account" means and
 * why the probes aggregate). The report is parked on the shared run state, which is how every
 * later check knows whether it may place an order at all — a failed preflight skips the rest of
 * the suite instead of trading against an unknown account.
 */

import type { LiveContext } from '../context.js'
import { subAccountPreflight } from '../preflight.js'
import type { LiveCheck } from '../registry.js'

export const preflightCheck: LiveCheck = {
  name: 'subaccount-preflight',
  specRef: '16 §2 sub-accounts',
  async run(ctx: LiveContext) {
    const report = await subAccountPreflight({
      exchange: ctx.adapter,
      allocatedCapitalUsdt: ctx.subaccount.allocatedCapitalUsdt,
      log: ctx.log,
    })
    ctx.state.preflight = report

    if (!report.ok) {
      throw new Error(
        `sub-account '${ctx.subaccount.subAccountLabel}' failed preflight: ` +
          report.violations.map((v) => `${v.kind}: ${v.detail}`).join('; '),
      )
    }
    return {
      status: 'pass',
      detail: {
        subAccountLabel: ctx.subaccount.subAccountLabel,
        balanceUsdt: report.balanceUsdt,
        maxBalanceUsdt: report.maxBalanceUsdt,
      },
    }
  },
}

/**
 * Guard every order-placing check shares: no `ok` preflight, no orders. Returns the skip
 * outcome to hand straight back, or `undefined` when the run may trade.
 */
export function requirePreflight(ctx: LiveContext): { readonly status: 'skip'; readonly reason: string } | undefined {
  if (ctx.state.preflight?.ok === true) return undefined
  return { status: 'skip', reason: 'sub-account preflight did not pass — refusing to place a live order' }
}
