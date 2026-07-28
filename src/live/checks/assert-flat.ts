/**
 * `assert-flat` — the last check of every live suite (task 0470 phase 4).
 *
 * Runs the shared teardown (`../teardown.ts`: cancel sweep → `flattenAll` → REST verification)
 * and passes **only** on `verifiedFlat`. It asserts the account state, not the absence of an
 * error: "we sent the closes" is not "the account is flat", and a live sub-account left holding
 * a position keeps costing real money after the process exits.
 *
 * The report is memoized inside the teardown, so the CLI's `finally` (and its signal handler)
 * observe this same run rather than starting a competing flatten ladder.
 */

import type { LiveContext } from '../context.js'
import type { LiveCheck } from '../registry.js'

export const assertFlatCheck: LiveCheck = {
  name: 'assert-flat',
  specRef: '13 §4 flatten',
  async run(ctx: LiveContext) {
    const report = await ctx.teardown.run('suite-end')
    ctx.state.teardown = report

    if (!report.verifiedFlat) {
      throw new Error(
        `sub-account '${ctx.subaccount.subAccountLabel}' is NOT flat — MANUAL INTERVENTION REQUIRED: ` +
          `${report.openPositions.length} position(s), ${report.openOrders.length} open order(s)` +
          (report.errors.length > 0 ? `; errors: ${report.errors.join('; ')}` : ''),
      )
    }
    return {
      status: 'pass',
      detail: {
        cancelled: report.cancelled,
        flattened: report.flattened,
        residuals: report.residuals.length,
        errors: report.errors,
      },
    }
  },
}
