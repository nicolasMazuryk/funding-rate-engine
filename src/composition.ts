/**
 * Composition helpers (task 0280) — the shared engine wiring extracted so both
 * `main.ts` (live run) and the test harness (`build-skeleton-harness.ts`) resolve
 * the same strategy + exit-policy registries. 0270 deferred this extract to here.
 *
 * Two seams:
 *  - {@link runtimeConfigFromEffective}: the `EffectiveConfig` → engine-facing
 *    {@link RuntimeStrategyConfig} projection (`strategyParams`/`sizing`/profile fees).
 *  - {@link wireS1Engine}: build the engine given concrete ports, registering the S1
 *    module + the real `timed` handler.
 *
 * This is impure only by association — it imports no I/O; the caller supplies the
 * ports. It sits outside `src/core/` because it references `src/config`.
 */

import type { EffectiveConfig } from './config/effective-config.js'
import { createFundingFeeEventHandler } from './core/intent/exit-policies/funding-fee-event.js'
import { createRetracementHandler } from './core/intent/exit-policies/retracement.js'
import {
  createLadderSlTpDeadlineHandler,
  createSlTpDeadlineHandler,
} from './core/intent/exit-policies/sl-tp-deadline.js'
import { TIMED_HANDLER } from './core/intent/exit-policies/timed.js'
import { createExitPolicyRegistry } from './core/intent/exit-policy.js'
import type { Clock } from './core/ports/clock.js'
import type { EngineDeps } from './core/runtime/engine.js'
import { createEngine, type Engine } from './core/runtime/engine.js'
import type { FundingIncomePoll } from './core/runtime/funding-gate.js'
import { createStrategyRegistry, type RuntimeStrategyConfig } from './core/strategies/registry.js'
import { createStrategy1 } from './core/strategies/strategy-1.js'
import { createStrategy1Ws } from './core/strategies/strategy-1-ws.js'
import { createStrategy2 } from './core/strategies/strategy-2.js'
import { createStrategy3a, strategy3aGeometry } from './core/strategies/strategy-3a.js'
import { createStrategy4_1a, strategy4_1aTpGeometry } from './core/strategies/strategy-4-1a.js'
import { createStrategy4_2a } from './core/strategies/strategy-4-2a.js'

/** Read a numeric strategy param or fail loud — a missing/non-numeric key is a config bug. */
function numberParam(params: Readonly<Record<string, number | string>>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number') throw new Error(`composition: strategy param '${key}' is not a number (${value})`)
  return value
}

/** Read a numeric sizing field or fail loud — a missing key is a config bug (`09` §5 validated it). */
function sizingField(sizing: Readonly<Record<string, number>>, key: string): number {
  const value = sizing[key]
  if (typeof value !== 'number') throw new Error(`composition: sizing field '${key}' is missing`)
  return value
}

/**
 * Project the frozen {@link EffectiveConfig} into the engine-facing
 * {@link RuntimeStrategyConfig}. S1's shape (`01` §5): negative-funding threshold,
 * entry/exit offsets, USD sizing + leverage, and the profile fees the advisory
 * cost model reads (`00_globals.md` §1.1).
 */
export function runtimeConfigFromEffective(cfg: EffectiveConfig): RuntimeStrategyConfig {
  const params = cfg.strategyParams
  // The exit offset (S1's `timed`) and the funding-fee timeout (S1-WS's gate) are read
  // conditionally: each strategy's YAML carries only its own, so reading the absent one
  // unconditionally would throw. S1-WS has no `exit_offset_seconds`; S1 no `funding_fee_timeout_seconds`.
  const base = {
    id: cfg.strategy,
    thresholdPercent: numberParam(params, 'negativeFundingThresholdPercent'),
    direction: 'negative' as const,
    entryOffsetSeconds: numberParam(params, 'entryOffsetSeconds'),
    amountUsd: sizingField(cfg.sizing, 'amountUsd'),
    leverage: sizingField(cfg.sizing, 'leverage'),
    costFees: { takerFeePct: cfg.exchangeProfile.takerFeePct, makerFeePct: cfg.exchangeProfile.makerFeePct },
    costParams: params,
  }
  // Each strategy's YAML carries only its own exit params, so read them by `cfg.strategy`
  // (reading an absent key would throw): S2 has the funding-fee timeout + trailing/SL/deadline
  // params, S1-WS just the timeout, S1 the `timed` exit offset.
  if (cfg.strategy === 's2') {
    return {
      ...base,
      fundingFeeTimeoutSeconds: numberParam(params, 'fundingFeeTimeoutSeconds'),
      retracementPct: numberParam(params, 'retracementPct'),
      slMultiplier: numberParam(params, 'slMultiplier'),
      deadlineSeconds: numberParam(params, 'deadlineSeconds'),
    }
  }
  if (cfg.strategy === 's1-ws') {
    return { ...base, fundingFeeTimeoutSeconds: numberParam(params, 'fundingFeeTimeoutSeconds') }
  }
  // S3a is the first SHORT strategy (`04` §1): `entrySide: 'short'` drives the trade side while
  // `direction` stays `negative` (the funding-ordering family). Its OCO exit reads the fixed-percent
  // SL + funding-scaled TP params; the deadline is shared with S2.
  if (cfg.strategy === 's3a') {
    return {
      ...base,
      entrySide: 'short',
      stopLossPercent: numberParam(params, 'stopLossPercent'),
      tpVariantAMultiplier: numberParam(params, 'tpVariantAMultiplier'),
      deadlineSeconds: numberParam(params, 'deadlineSeconds'),
    }
  }
  // S4.1a is a LONG ladder (`05` §2): no `entrySide` (default long); reads the ladder keys +
  // engine-side SL multiplier + per-fill TP + shared deadline. The ladder entry path is switched
  // on by the module's `entryPlan`, not this config.
  if (cfg.strategy === 's4-1a') {
    return {
      ...base,
      ladderCount: numberParam(params, 'ladderCount'),
      ladderTopMult: numberParam(params, 'ladderTopMult'),
      ladderBottomMult: numberParam(params, 'ladderBottomMult'),
      takeProfitPct: numberParam(params, 'takeProfitPct'),
      slMultiplier: numberParam(params, 'slMultiplier'),
      deadlineSeconds: numberParam(params, 'deadlineSeconds'),
    }
  }
  // S4.2a is the ladder collapsed to one BUY-LIMIT (`06` §2): no `entrySide` (default long); reads the
  // single-limit offset + engine-side SL multiplier + per-fill TP + deadline (which also drives the
  // limit's `expireAt`). The single-limit entry path is switched on by the module's `entryPlan`.
  if (cfg.strategy === 's4-2a') {
    return {
      ...base,
      limitOffsetMult: numberParam(params, 'limitOffsetMult'),
      takeProfitPct: numberParam(params, 'takeProfitPct'),
      slMultiplier: numberParam(params, 'slMultiplier'),
      deadlineSeconds: numberParam(params, 'deadlineSeconds'),
    }
  }
  return { ...base, exitOffsetSeconds: numberParam(params, 'exitOffsetSeconds') }
}

/** The engine deps a caller supplies; the S1 registry + exit-policy registry are wired here. */
export type S1EngineDeps = Omit<EngineDeps, 'registry' | 'exitPolicyRegistry'>

/** Wire the engine with the S1 strategy module and the real `timed` exit handler. */
export function wireS1Engine(deps: S1EngineDeps): Engine {
  return createEngine({
    ...deps,
    registry: createStrategyRegistry([createStrategy1()]),
    exitPolicyRegistry: createExitPolicyRegistry([TIMED_HANDLER]),
  })
}

/** The gate ports the `funding_fee_event` handler needs: the clock + the REST funding-income poll. */
export interface S1WsGateDeps {
  readonly clock: Clock
  readonly fundingIncome: FundingIncomePoll
}

/**
 * Wire the engine with the S1-WS strategy module and the `funding_fee_event` handler
 * (task 0300). The handler owns a funding gate built from the injected clock + REST poll;
 * the engine's out-of-band `requestExit` seam fires the exit on a gate signal.
 */
export function wireS1WsEngine(deps: S1EngineDeps, gate: S1WsGateDeps): Engine {
  return createEngine({
    ...deps,
    registry: createStrategyRegistry([createStrategy1Ws()]),
    exitPolicyRegistry: createExitPolicyRegistry([createFundingFeeEventHandler(gate)]),
  })
}

/**
 * Wire the engine with the S2 strategy module and the `sl_tp_deadline_retracement_funding_event`
 * handler (task 0310). The handler owns a funding gate (built from the injected clock + REST
 * poll) whose close arms the retracement tracker, and places its resting SL/TP legs through the
 * engine's exit-policy order-command seam. `gate` reuses the S1-WS shape (clock + funding-income poll).
 */
export function wireS2Engine(deps: S1EngineDeps, gate: S1WsGateDeps): Engine {
  return createEngine({
    ...deps,
    registry: createStrategyRegistry([createStrategy2()]),
    exitPolicyRegistry: createExitPolicyRegistry([createRetracementHandler(gate)]),
  })
}

/**
 * Wire the engine with the S3a strategy module and the `sl_tp_deadline` handler (task 0320).
 * The handler places a static reduce-only OCO pair (SL stop above entry, TP limit below) through
 * the engine's exit-policy order-command seam, bounded by a deadline market close — no gate deps.
 * The S3a price geometry (fixed-percent SL, funding-scaled TP) is injected from the module.
 */
export function wireS3aEngine(deps: S1EngineDeps): Engine {
  return createEngine({
    ...deps,
    registry: createStrategyRegistry([createStrategy3a()]),
    exitPolicyRegistry: createExitPolicyRegistry([createSlTpDeadlineHandler(strategy3aGeometry)]),
  })
}

/**
 * Wire the engine with the S4.1a ladder module + the **ladder** `sl_tp_deadline` handler (task 0330).
 * The module's `entryPlan` switches the engine to the N-rung ladder path (engine-side conditional SL
 * armed at placement, TP re-placed per rung fill); the ladder handler owns only the per-fill TP.
 */
export function wireS4_1aEngine(deps: S1EngineDeps): Engine {
  return createEngine({
    ...deps,
    registry: createStrategyRegistry([createStrategy4_1a()]),
    exitPolicyRegistry: createExitPolicyRegistry([createLadderSlTpDeadlineHandler(strategy4_1aTpGeometry)]),
  })
}

/**
 * Wire the engine with the S4.2a single-limit module + the **ladder** `sl_tp_deadline` handler
 * (task 0340). S4.2a is the S4.1a ladder collapsed to one rung: its `entryPlan` drives the same
 * engine ladder path (one BUY-LIMIT, engine-side conditional SL armed at placement, per-fill TP),
 * and its `entryExpiryErrorCode` adds the `limit_expired` no-fill terminal. TP math is identical to
 * S4.1a, so the handler reuses `strategy4_1aTpGeometry`.
 */
export function wireS4_2aEngine(deps: S1EngineDeps): Engine {
  return createEngine({
    ...deps,
    registry: createStrategyRegistry([createStrategy4_2a()]),
    exitPolicyRegistry: createExitPolicyRegistry([createLadderSlTpDeadlineHandler(strategy4_1aTpGeometry)]),
  })
}
