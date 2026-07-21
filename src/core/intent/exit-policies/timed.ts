/**
 * The `timed` exit policy (`01_strategy_1.md` §3) — pure core. S1's one and only
 * exit path: a SELL MARKET reduce-only fired at `T_settle + exitOffsetSeconds`,
 * `exit_reason = timed` on every trade.
 *
 * The deadline is keyed to **`T_settle`** (absolute), never fill time — the
 * load-bearing behavioural change from the 0270 placeholder, which armed off
 * `enteredAtMs + holdMs`. The exit landing before/after `T_drop` is the strategy's
 * variance and must not be optimised away (`01` §6), so the instant is derived
 * purely from settlement + the configured offset.
 *
 * On crash-recovery re-arm the deadline is already known (persisted `deadlineMs`),
 * so the handler reuses it verbatim rather than recomputing from `settleTs`.
 */

import type { RuntimeStrategyConfig } from '../../strategies/registry.js'
import type { ExitDecision, ExitPolicyHandler, MonitoredIntent } from '../exit-policy.js'

/** Absolute deadline instant for a live arm: `T_settle + exitOffsetSeconds` (`01` §3). */
function deadlineFromSettle(intent: MonitoredIntent, config: RuntimeStrategyConfig): number {
  if (intent.settleTs === undefined) {
    throw new Error(`TIMED_HANDLER: intent '${intent.intentId}' has no settleTs to arm the timed exit against`)
  }
  return intent.settleTs + config.exitOffsetSeconds * 1000
}

/** The real `timed` handler (replaces the 0270 `TIMED_PLACEHOLDER_HANDLER`). */
export const TIMED_HANDLER: ExitPolicyHandler = {
  kind: 'timed',
  arm(intent, config, ctx): number {
    // Live path derives the deadline from `T_settle`; recovery reuses the persisted instant.
    const deadlineMs = intent.deadlineMs ?? deadlineFromSettle(intent, config)
    ctx.scheduleDeadline(intent.intentId, deadlineMs)
    return deadlineMs
  },
  onEvent(event, intent): ExitDecision | undefined {
    if (event.type === 'Timer' && event.kind === 'deadline' && event.intentId === intent.intentId) {
      return { exitReason: 'timed' }
    }
    return undefined
  },
}
