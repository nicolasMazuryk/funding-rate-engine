/**
 * Strategy registry — pure core (`08_system_overview.md` §5 Registry pattern;
 * `12_strategy_runtime_and_intent_lifecycle.md` §2).
 *
 * Dispatch to the active strategy is a map lookup, not a `switch` — new strategy
 * modules (`01`–`07`, tasks 0280+) register without touching the engine. Each
 * module is a pure selector: given an engine-filtered {@link Candidate} and the
 * runtime config, it returns a {@link StrategyTrigger} or declines. The three
 * strategy-agnostic guards (proximity / freshness / imminence) run *before*
 * `select` in the finder; the module only applies its own threshold rule.
 */

import type { StrategyId } from '../../config/canonical.js'
import type { ExitPolicyKind } from '../intent/exit-policy.js'
import type { ErrorCode } from '../intent/intent-machine.js'
import type { Side } from '../ports/exchange-adapter.js'
import type { FeeInputs } from '../runtime/cost-model.js'
import type { Candidate } from '../runtime/finder.js'

/** Exit-policy family a module uses. The kind union is owned by `exit-policy.ts` (single source of truth). */
export type { ExitPolicyKind }

/**
 * Engine-level runtime config passed to `select` and consumed by the engine
 * (`08` §5). A small explicit shape — not the full `EffectiveConfig` — so `core`
 * takes no dependency on `src/config` loading before `main.ts` exists.
 */
export interface RuntimeStrategyConfig {
  readonly id: StrategyId
  /** Selection threshold, signed percent (`00_globals.md` §1.2). */
  readonly thresholdPercent: number
  /** Which ordering family applies: `negative` most-negative-first, `positive` most-positive-first. */
  readonly direction: 'negative' | 'positive'
  /** Trade side (`04` §1): `short` for S3a, default `long`. Orthogonal to `direction` (the funding-ordering family). */
  readonly entrySide?: Side
  /** Fixed SL distance, percent — NOT a multiple of `|F|` (`04` §5, contrast `slMultiplier`). S3a only. */
  readonly stopLossPercent?: number
  /** TP distance multiplier on `|F|` (`tp_variant_a_multiplier`, `04` §3/§5). S3a only. */
  readonly tpVariantAMultiplier?: number
  /** Delay before `T_settle` at which the entry timer fires, seconds (`entry_offset_seconds`). */
  readonly entryOffsetSeconds: number
  /** Delay after `T_settle` at which the `timed` exit fires, seconds (`exit_offset_seconds`, S1). Absent for the WS-gated strategies (S1-WS/S2/S6). */
  readonly exitOffsetSeconds?: number
  /** Gate timeout past `T_settle`, seconds (`funding_fee_timeout_seconds`, `02` §5). Present for the `funding_fee_event` + S2 policies. */
  readonly fundingFeeTimeoutSeconds?: number
  /** Trailing-TP retracement fraction [0,1] (`retracement_pct`, `03` §5 — the lone fraction key). S2 only. */
  readonly retracementPct?: number
  /** SL distance multiplier on `|F|` (`sl_multiplier`, `03` §5 / `05` §2). S2 + S4.1a. */
  readonly slMultiplier?: number
  /** Deadline horizon past `T_settle`, seconds (`deadline_seconds`, `03` §5 / `05` §5). S2 + S3a + S4.1a. */
  readonly deadlineSeconds?: number
  /** Ladder rung count (`ladder_count`, `05` §5). S4.1a only — presence drives the ladder entry path. */
  readonly ladderCount?: number
  /** Top-rung offset multiplier on `|F|` (`ladder_top_mult`, `05` §2). S4.1a only. */
  readonly ladderTopMult?: number
  /** Bottom-rung offset multiplier on `|F|` (`ladder_bottom_mult`, `05` §2; `> ladderTopMult`). S4.1a only. */
  readonly ladderBottomMult?: number
  /** TP distance above `P_avg`, percent (`take_profit_pct`, `05` §3). S4.1a + S4.2a. */
  readonly takeProfitPct?: number
  /** Offset multiplier on `|F|` for the single BUY-LIMIT (`limit_offset_mult`, `06` §5). S4.2a only. */
  readonly limitOffsetMult?: number
  /** Fixed notional per intent, quote currency (`00_globals.md` §4); sized to a qty in the runtime (`00_globals.md` §4). */
  readonly amountUsd: number
  /** Balance-check divisor — required margin is `amountUsd / leverage` (`11` §7). */
  readonly leverage: number
  /** Fee inputs for the advisory cost-model gate (task 0150). Absent ⇒ no evaluation. */
  readonly costFees?: FeeInputs
  /** Strategy params the cost model reads (e.g. `tpVariantAMultiplier`, `takeProfitPct`). Absent ⇒ no evaluation. */
  readonly costParams?: Readonly<Record<string, number | string>>
}

/** A module's decision to act on a candidate: the symbol and the settlement it entered against. */
export interface StrategyTrigger {
  readonly symbol: string
  readonly settleTs: number
}

/**
 * Ladder entry geometry (`05_strategy_4_1a.md` §2) — the pure strategy math a
 * ladder module supplies. Presence of {@link StrategyModule.entryPlan} switches the
 * engine from its single market entry to the N-rung ladder path; the two callbacks
 * own all S4.1a price math (rung ladder + engine-side SL anchor) while the engine
 * owns placement, aggregation, and the conditional-stop lifecycle.
 */
export interface LadderEntryPlan {
  /**
   * Rung BUY-LIMIT prices below `refPrice` (`05` §2): `ladder_top/bottom = refPrice ×
   * (1 − |F| × mult/100)`, linearly interpolated across `ladderCount`. `|F| =
   * abs(ratePercent ?? thresholdPercent)`. Prices are raw — the engine tick-snaps them.
   */
  rungPrices(refPrice: number, config: RuntimeStrategyConfig, ratePercent?: number): number[]
  /** Engine-side conditional-SL trigger from the precomputed `P_avg_full` (`05` §2 step 1). */
  slTriggerPrice(pAvgFull: number, config: RuntimeStrategyConfig, ratePercent?: number): number
}

/** One strategy module: an id, its exit-policy family, and a pure selector. */
export interface StrategyModule {
  readonly id: StrategyId
  readonly exitPolicyKind: ExitPolicyKind
  /** Apply the module's own threshold rule to a guarded candidate; `undefined` declines. */
  select(candidate: Candidate, config: RuntimeStrategyConfig): StrategyTrigger | undefined
  /**
   * Ladder entry geometry (`05` §2, S4.1a/S4.2a). Absent ⇒ the engine uses its single
   * market entry (every non-ladder strategy is byte-unchanged); present ⇒ the ladder path.
   */
  readonly entryPlan?: LadderEntryPlan
  /**
   * No-fill terminal error code for a ladder/single-limit entry (`06` §2 R5, S4.2a). When set, the
   * engine carries `expireAt` on each entry limit and a zero-fill expiry terminates
   * `NO_POSITION{this}` instead of `ladder_no_fills`. Absent ⇒ existing behavior (S4.1a
   * byte-unchanged): entry limits carry no `expireAt` and the no-fill terminal stays `ladder_no_fills`.
   */
  readonly entryExpiryErrorCode?: ErrorCode
}

export type StrategyRegistry = ReadonlyMap<StrategyId, StrategyModule>

/** Build the registry from the modules; a duplicate id is a fail-loud startup error. */
export function createStrategyRegistry(modules: readonly StrategyModule[]): StrategyRegistry {
  const registry = new Map<StrategyId, StrategyModule>()
  for (const module of modules) {
    if (registry.has(module.id)) throw new Error(`StrategyRegistry: duplicate strategy id '${module.id}'`)
    registry.set(module.id, module)
  }
  return registry
}
