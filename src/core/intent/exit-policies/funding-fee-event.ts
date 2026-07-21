/**
 * The `funding_fee_event` exit policy (`02_strategy_1_ws.md` §2/§3) — pure core. S1-WS's
 * exit path: a SELL MARKET reduce-only fired when the funding the position bet on is
 * **confirmed accrued**, not on a fixed clock. It plugs the standalone funding gate
 * (task 0290) into the engine's exit-policy seam for the first time.
 *
 * The handler owns one shared {@link FundingGate} (all armed intents share it — the gate
 * keys per-intent). Three convergent paths, all resolving through `ctx.requestExit`:
 *  - WS `funding_fee` within ±5 s of `T_settle` → gate opens `ws` → `funding_fee_event`;
 *  - REST funding-income poll at `T_settle+3 s` observing the credit → opens `rest` → same;
 *  - neither by `T_settle + fundingFeeTimeoutSeconds` → `timeout` → `funding_fee_timeout`.
 *
 * The gate's REST poll and timeout resolve **outside** the engine's synchronous `onEvent`
 * dispatch (an async `Promise`, a gate-owned `clock` timer), which is exactly why the seam
 * needed the out-of-band `ctx.requestExit` — `onEvent` here only forwards WS events into
 * the gate and always returns `undefined`; the exit fires via the observer → `requestExit`.
 *
 * `arm` returns `T_settle + fundingFeeTimeoutSeconds*1000` as the persisted deadline, so
 * crash-recovery re-arm (0370) re-schedules the gate from the WAL for free.
 */

import type { Clock } from '../../ports/clock.js'
import type { FundingGate, FundingIncomePoll } from '../../runtime/funding-gate.js'
import { createFundingGate } from '../../runtime/funding-gate.js'
import type { ExitPolicyContext, ExitPolicyHandler } from '../exit-policy.js'
import type { ExitReason } from '../intent-machine.js'

/** The ports the handler injects into its funding gate: the clock + the REST funding-income poll. */
export interface FundingFeeEventDeps {
  readonly clock: Clock
  readonly fundingIncome: FundingIncomePoll
}

/** Build the `funding_fee_event` handler (S1-WS), owning one shared funding gate. */
export function createFundingFeeEventHandler(deps: FundingFeeEventDeps): ExitPolicyHandler {
  // The engine binds `exitCtx` once, so capturing it on the first `arm` is stable; the
  // gate observer (created before any arm) reads it to fire the out-of-band exit.
  let capturedCtx: ExitPolicyContext | undefined

  const gate: FundingGate = createFundingGate({
    clock: deps.clock,
    poll: deps.fundingIncome,
    observer: (signal) => {
      // Only the finalizing `GateClosed` fires the exit; the preceding `GateOpened`
      // (carrying `t_drop_offset_s` for analytics) is diagnostic and ignored here.
      if (signal.type !== 'GateClosed') return
      const exitReason: ExitReason = signal.reason === 'timeout' ? 'funding_fee_timeout' : 'funding_fee_event'
      capturedCtx?.requestExit(signal.intentId, exitReason)
    },
  })

  return {
    kind: 'funding_fee_event',
    arm(intent, config, ctx): number {
      capturedCtx = ctx
      if (intent.settleTs === undefined) {
        throw new Error(
          `FUNDING_FEE_EVENT_HANDLER: intent '${intent.intentId}' has no settleTs to arm the gate against`,
        )
      }
      if (config.fundingFeeTimeoutSeconds === undefined) {
        throw new Error(`FUNDING_FEE_EVENT_HANDLER: intent '${intent.intentId}' config has no fundingFeeTimeoutSeconds`)
      }
      const timeoutSeconds = config.fundingFeeTimeoutSeconds
      gate.arm({ intentId: intent.intentId, symbol: intent.symbol, settleTs: intent.settleTs, timeoutSeconds })
      // Persisted deadline = the timeout instant, so 0370 recovery re-arms the gate for free.
      return intent.settleTs + timeoutSeconds * 1000
    },
    onEvent(event, intent): undefined {
      // Forward the matched WS funding-fee into the gate; the exit fires via `requestExit`.
      if (event.type === 'FundingFeeAccrued' && event.symbol === intent.symbol) gate.onFundingFee(event)
      return undefined
    },
    dispose(): void {
      gate.dispose()
    },
  }
}
