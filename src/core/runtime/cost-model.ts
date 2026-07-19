/**
 * Cost model — the economic gate (`00_globals.md` §1.1 `NET_PNL = DELTA_PNL +
 * FUNDING_PNL − FEES`; task 0150). Pure core: fee/threshold inputs in, a
 * {@link ProfitBreakdown} out. No I/O, no `Date.now()`.
 *
 * Each strategy family (`00_globals.md` §G: L/S/R/D) has one profit condition,
 * evaluated with live fee/threshold inputs. It is **advisory** at selection time
 * (the realized drop is unknown ex-ante, so `exPost*` terms default to 0) and
 * **binding** at config-load time for Group L, where a threshold too shallow to
 * clear round-trip fees is structurally uneconomic regardless of outcome
 * (`00_globals.md` §11-R10; `01_strategy_1.md` §4).
 *
 * Scope (see task 0150 plan): one canonical path per strategy id — the TP/primary
 * path — not every exit path (S2/S3a have three). The named fee helpers still
 * expose the other paths as pure utilities for callers that need them.
 */

import type { StrategyId } from '../../config/canonical.js'

/** Round-trip fee rates, signed percent (`00_globals.md` §1.2): `0.05` = 0.05%. */
export interface FeeInputs {
  readonly takerFeePct: number
  readonly makerFeePct: number
}

export interface CostModelInputs {
  /** Funding rate `F`, signed percent (`00_globals.md` §1.2). */
  readonly fundingRatePercent: number
  readonly fees: FeeInputs
  readonly params: Readonly<Record<string, number | string>>
  /** Ex-post `DELTA_PNL`/`MAIN_DELTA`, percent — unknown ex-ante, default 0. */
  readonly exPostDeltaPnlPercent?: number
  /** Ex-post exchange-sourced `FUNDING_PNL` (Group R), percent — default 0. */
  readonly exPostFundingPnlPercent?: number
}

export interface ProfitBreakdown {
  readonly deltaTerm: number
  readonly fundingTerm: number
  readonly feeTerm: number
  /** `deltaTerm + fundingTerm > feeTerm` (i.e. `NET_PNL > 0`). */
  readonly passes: boolean
}

export type ProfitEvaluator = (inputs: CostModelInputs) => ProfitBreakdown

// Fee helpers — one per §4 table entry actually used. Named by exit path so
// callers outside the canonical-path evaluators can reuse the arithmetic.

/** Group L round-trip: taker entry + taker exit. */
export function groupLFees(fees: FeeInputs): number {
  return fees.takerFeePct * 2
}

/** S3a take-profit path: taker entry + maker (limit) exit. */
export function s3aTpFees(fees: FeeInputs): number {
  return fees.takerFeePct + fees.makerFeePct
}

/** S3a stop-loss / deadline path: taker entry + taker exit. */
export function s3aSlOrDeadlineFees(fees: FeeInputs): number {
  return fees.takerFeePct * 2
}

/** Group R take-profit path: maker entry + maker exit. */
export function groupRTpFees(fees: FeeInputs): number {
  return fees.makerFeePct * 2
}

/** S6 (Group D): taker×3 (PRE entry + MAIN entry + abort leg) + maker (tp exit). */
export function s6Fees(fees: FeeInputs): number {
  return fees.takerFeePct * 3 + fees.makerFeePct
}

function readNumber(params: Readonly<Record<string, number | string>>, key: string): number {
  const value = params[key]
  return typeof value === 'number' ? value : 0
}

/** Group L (s1, s1-ws, s2): `|F| > |DELTA_PNL| + FEES`. */
const evalGroupL: ProfitEvaluator = (inputs) => {
  const feeTerm = groupLFees(inputs.fees)
  const fundingTerm = Math.abs(inputs.fundingRatePercent)
  const deltaTerm = inputs.exPostDeltaPnlPercent ?? 0
  return { deltaTerm, fundingTerm, feeTerm, passes: deltaTerm + fundingTerm > feeTerm }
}

/** Group S (s3a) TP path: `DELTA_PNL > |F| + FEES`, with `DELTA_PNL = |F| × tpMult`. */
const evalS3a: ProfitEvaluator = (inputs) => {
  const feeTerm = s3aTpFees(inputs.fees)
  const absF = Math.abs(inputs.fundingRatePercent)
  const deltaTerm = absF * readNumber(inputs.params, 'tpVariantAMultiplier')
  const fundingTerm = -absF
  return { deltaTerm, fundingTerm, feeTerm, passes: deltaTerm + fundingTerm > feeTerm }
}

/** Group R (s4-1a, s4-2a) TP path: `DELTA_PNL + FUNDING_PNL > FEES`; FUNDING_PNL exchange-sourced (default 0). */
const evalGroupR: ProfitEvaluator = (inputs) => {
  const feeTerm = groupRTpFees(inputs.fees)
  const fundingTerm = inputs.exPostFundingPnlPercent ?? 0
  const deltaTerm = readNumber(inputs.params, 'takeProfitPct')
  return { deltaTerm, fundingTerm, feeTerm, passes: deltaTerm + fundingTerm > feeTerm }
}

/**
 * Group D (s6): `MAIN_DELTA > |PRE_FUNDING_DELTA| + |FUNDING_PRE| + FEES`. The
 * PRE-leg amounts are exchange-sourced live values, not derivable ex-ante, so
 * `fundingTerm` proxies `|PRE_FUNDING_DELTA| + |FUNDING_PRE|` with `|F|` — a
 * documented approximation (no spec-cited number to verify against).
 */
const evalS6: ProfitEvaluator = (inputs) => {
  const feeTerm = s6Fees(inputs.fees)
  const fundingTerm = -Math.abs(inputs.fundingRatePercent)
  const deltaTerm = inputs.exPostDeltaPnlPercent ?? 0
  return { deltaTerm, fundingTerm, feeTerm, passes: deltaTerm + fundingTerm > feeTerm }
}

/** One canonical evaluator per strategy id, keyed like {@link StrategyRegistry}. */
export const PROFIT_EVALUATORS: ReadonlyMap<StrategyId, ProfitEvaluator> = new Map<StrategyId, ProfitEvaluator>([
  ['s1', evalGroupL],
  ['s1-ws', evalGroupL],
  ['s2', evalGroupL],
  ['s3a', evalS3a],
  ['s4-1a', evalGroupR],
  ['s4-2a', evalGroupR],
  ['s6', evalS6],
])

/** Evaluate the canonical profit condition for `strategyId`; a missing id is a wiring bug. */
export function evaluateProfitCondition(strategyId: StrategyId, inputs: CostModelInputs): ProfitBreakdown {
  const evaluator = PROFIT_EVALUATORS.get(strategyId)
  if (evaluator === undefined) throw new Error(`cost-model: no profit evaluator for strategy id '${strategyId}'`)
  return evaluator(inputs)
}
