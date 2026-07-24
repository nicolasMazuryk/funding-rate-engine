/**
 * Post-trade P&L decomposition — pure core (`15_accounting_and_reconciliation.md`
 * §1/§3, `00_globals.md` §8.3; task 0390).
 *
 * Books one intent's realized outcome into the `pnl` column set from **realized
 * facts**, never assumptions: realized fill prices, the venue-settled funding
 * amount (never derived from `|F|` — `00_globals` §G-R/R7), and fees by the fee
 * class of the order type that actually filled (reusing `cost-model.ts`'s
 * per-path helpers). Deterministic and I/O-free, so the accounting sidecar
 * (edge) and reconciliation (0400, re-runs over venue-corrected facts) share it.
 *
 * UNIT — DELIBERATE DEVIATION FROM SPEC §8.3 (user decision, binding). The value
 * columns (`deltaPnl`, `fundingPnl`, `feeCost`, `netPnl`) are **quote currency**,
 * not the percent §8.3 marks them. Funding is natively quote-ccy (the venue
 * `amount`), and fleet rollup (`15` §5) sums money — so quote-ccy is the cleaner
 * store. The §4 percent formulas are converted to quote amounts here
 * (`amount = pct/100 × notional`). Recorded in STATUS + here.
 */

import type { StrategyId } from '../../config/canonical.js'
import type { ErrorCode, ExitReason } from '../intent/intent-machine.js'
import type { Side } from '../ports/exchange-adapter.js'
import {
  type FeeInputs,
  groupLFees,
  groupRTpFees,
  s3aSlOrDeadlineFees,
  s3aTpFees,
  s6Fees,
} from '../runtime/cost-model.js'

/**
 * The realized-fact snapshot the engine's close hook hands the assembler — the
 * in-memory `IntentRecord` projection at the terminal transition plus the closing
 * fill price and the venue-settled funding amount. Fed from the engine at close
 * time (the `fills` table carries no leg/side tag, so entry-vs-exit fills cannot
 * be split from it — `15` grounding); 0400 re-runs the assembler over venue-
 * corrected facts.
 */
export interface TradeFacts {
  readonly intentId: string
  readonly strategyId: StrategyId
  /** Managed trade direction (`mainSide` for S6). */
  readonly entrySide: Side
  /** Set on a CLOSED terminal (a position existed and was closed). */
  readonly exitReason?: ExitReason
  /** Set on a NO_POSITION terminal (no managed position — `ladder_no_fills` / `limit_expired`). */
  readonly errorCode?: ErrorCode
  /** Single-entry fill price, quote ccy (non-ladder). */
  readonly pEntry?: number
  /** Closing fill price, quote ccy. */
  readonly pExit?: number
  /** Fill-weighted average entry, quote ccy (ladder). `P_base = pAvg ?? pEntry`. */
  readonly pAvg?: number
  /** Planned entry qty, base units. */
  readonly entryQty: number
  /** Realized filled qty, base units (ladder aggregate); the reduce-only exit cap. */
  readonly filledQty?: number
  /** Number of entry fills (ladder rungs filled; 1 for a single entry, 0 if none). */
  readonly fillCount: number
  /** Venue-settled funding amount, quote ccy, signed (credit +, charge −); 0 if none. Never `|F|`-derived (R7). */
  readonly settledFundingAmount: number
  /** Funding-accrual verdict (`00_globals` §3.1): entry filled before `T_settle`. */
  readonly fundingReceived: boolean
  /** Entry fill instant, epoch ms — hold-duration base. */
  readonly enteredAtMs?: number
  /** Terminal instant, epoch ms. */
  readonly closedAtMs: number
  /** Settlement instant the intent entered against, epoch ms. */
  readonly tSettleMs?: number
  /** `T_drop − T_settle`, seconds; null when the intent never observed a `T_drop`. */
  readonly tDropOffsetS?: number
  readonly fees: FeeInputs
  /**
   * Venue-corrected fee cost, quote ccy (positive), used verbatim as `feeCost` in place of the
   * config-percent derivation — the reconciliation fee-divergence correction (`15` §2, 0400).
   * Default-absent ⇒ every existing caller/golden derives fees from `fees` unchanged.
   */
  readonly feeCostOverride?: number
  // ── S6 two-leg fields (`07` §2). Absent for every other strategy. ──
  /** PRE_FUNDING leg fill price, quote ccy. */
  readonly preFillPx?: number
  /** MAIN leg fill price, quote ccy (the reversal anchor). Defaults to `pEntry`. */
  readonly mainEntryPx?: number
  /** PRE_FUNDING leg qty, base units. */
  readonly preQty?: number
}

/**
 * One `pnl` row's value set (`00_globals` §8.3; `schema.ts` `pnl`). The value
 * columns are **quote currency** (see file header — deliberate §8.3 deviation).
 * The instance triple is added by the repo writer.
 */
export interface PnlRecord {
  readonly intentId: string
  readonly pEntry?: number
  readonly pExit?: number
  readonly pAvg?: number
  /** Price-move P&L, quote ccy. */
  readonly deltaPnl: number
  /** Funding P&L, quote ccy (venue-settled amount, gated by the accrual verdict). */
  readonly fundingPnl: number
  /** Total fee cost, quote ccy. */
  readonly feeCost: number
  /** `deltaPnl + fundingPnl − feeCost` (property: recompute-from-components is identity). */
  readonly netPnl: number
  readonly exitReason?: ExitReason
  readonly errorCode?: ErrorCode
  readonly holdDurationS?: number
  readonly fillCount: number
  readonly fundingReceived: boolean
  readonly tDropOffsetS?: number
}

/** The three quote-ccy components a per-strategy assembler produces; `netPnl` is derived. */
interface Components {
  readonly deltaPnl: number
  readonly fundingPnl: number
  readonly feeCost: number
}

/** `P_base` — a ladder's fill-weighted `P_avg`, else the single entry fill. */
function pBase(facts: TradeFacts): number | undefined {
  return facts.pAvg ?? facts.pEntry
}

/** Realized traded qty — the ladder aggregate, else the planned qty. */
function realizedQty(facts: TradeFacts): number {
  return facts.filledQty ?? facts.entryQty
}

/** +1 for a long, −1 for a short — the sign of `(P_exit − P_base)` that is profit. */
function directionSign(side: Side): number {
  return side === 'long' ? 1 : -1
}

/** Direction-aware price-move P&L, quote ccy: `sign × (P_exit − P_base) × qty` (= §4 `deltaPct/100 × notional`). */
function singleLegDelta(facts: TradeFacts): number {
  const base = pBase(facts)
  if (base === undefined || facts.pExit === undefined) return 0
  return directionSign(facts.entrySide) * (facts.pExit - base) * realizedQty(facts)
}

/** Entry notional, quote ccy: `P_base × filledQty`. */
function notionalOf(facts: TradeFacts): number {
  return (pBase(facts) ?? 0) * realizedQty(facts)
}

/** Funding P&L, quote ccy: the settled venue amount, gated by the accrual verdict (never `|F|`, R7). */
function fundingComponent(facts: TradeFacts): number {
  return facts.fundingReceived ? facts.settledFundingAmount : 0
}

/** Convert a round-trip fee percent to a quote-ccy cost against the entry notional. */
function feeCost(feePct: number, facts: TradeFacts): number {
  return (feePct / 100) * notionalOf(facts)
}

/**
 * Group L (s1/s1-ws/s2): market entry + market exit (taker×2), except S2's
 * trailing-TP exit is a maker limit (taker entry + maker exit), so `tp_hit` books
 * the S3a TP fee class. `03` §4 / `01` §4.
 */
const assembleGroupL = (facts: TradeFacts): Components => {
  const feePct =
    facts.strategyId === 's2' && facts.exitReason === 'tp_hit' ? s3aTpFees(facts.fees) : groupLFees(facts.fees)
  return { deltaPnl: singleLegDelta(facts), fundingPnl: fundingComponent(facts), feeCost: feeCost(feePct, facts) }
}

/** S3a (Group S): taker entry, then maker TP (`tp_hit`) or taker SL/deadline exit (`04` §4). */
const assembleS3a = (facts: TradeFacts): Components => {
  const feePct = facts.exitReason === 'tp_hit' ? s3aTpFees(facts.fees) : s3aSlOrDeadlineFees(facts.fees)
  return { deltaPnl: singleLegDelta(facts), fundingPnl: fundingComponent(facts), feeCost: feeCost(feePct, facts) }
}

/**
 * Group R (s4-1a/s4-2a): maker (limit) ladder entry, then maker TP (`tp_hit`,
 * maker×2) or a taker market SL/deadline exit (maker entry + taker exit). `05`
 * §3 / `06` §5.
 */
const assembleGroupR = (facts: TradeFacts): Components => {
  const feePct =
    facts.exitReason === 'tp_hit' ? groupRTpFees(facts.fees) : facts.fees.makerFeePct + facts.fees.takerFeePct
  return { deltaPnl: singleLegDelta(facts), fundingPnl: fundingComponent(facts), feeCost: feeCost(feePct, facts) }
}

/**
 * Group D (s6): `MAIN_DELTA + PRE_FUNDING_DELTA + FUNDING_PRE − FEES` (`07` §2,
 * `15` §3). The full settled charge is booked to `FUNDING_PRE` — the conservative
 * default (`07` §2 / `15` §3), flagged for the canary audit (0500). `PRE_FUNDING_DELTA`
 * is the price move on the opposite PRE leg between its fill and the MAIN reversal
 * (≈ `mainEntryPx`); absent PRE fill facts it books 0. Fees geometry is taker×3 +
 * maker against the MAIN notional.
 */
const assembleS6 = (facts: TradeFacts): Components => {
  const qty = realizedQty(facts)
  const mainEntry = facts.mainEntryPx ?? pBase(facts) ?? 0
  const mainDelta = facts.pExit === undefined ? 0 : directionSign(facts.entrySide) * (facts.pExit - mainEntry) * qty
  const preSide: Side = facts.entrySide === 'long' ? 'short' : 'long'
  const preDelta =
    facts.preFillPx === undefined || facts.preQty === undefined
      ? 0
      : directionSign(preSide) * (mainEntry - facts.preFillPx) * facts.preQty
  const feeCostQuote = (s6Fees(facts.fees) / 100) * mainEntry * qty
  return { deltaPnl: mainDelta + preDelta, fundingPnl: fundingComponent(facts), feeCost: feeCostQuote }
}

/** One assembler per strategy id, keyed like {@link ../strategies/registry.ts}.StrategyRegistry. */
const ASSEMBLERS: ReadonlyMap<StrategyId, (facts: TradeFacts) => Components> = new Map([
  ['s1', assembleGroupL],
  ['s1-ws', assembleGroupL],
  ['s2', assembleGroupL],
  ['s3a', assembleS3a],
  ['s4-1a', assembleGroupR],
  ['s4-2a', assembleGroupR],
  ['s6', assembleS6],
] satisfies ReadonlyArray<[StrategyId, (facts: TradeFacts) => Components]>)

/** Hold duration in whole seconds, or `undefined` when the entry never filled. */
function holdDurationS(facts: TradeFacts): number | undefined {
  if (facts.enteredAtMs === undefined) return undefined
  return Math.round((facts.closedAtMs - facts.enteredAtMs) / 1000)
}

/**
 * Assemble one intent's `pnl` row from its realized facts. A NO_POSITION terminal
 * (no managed position — `ladder_no_fills` / `limit_expired`) books zero economics
 * and zero fills with its `error_code` (`00_globals` §10.2). A CLOSED terminal
 * dispatches to the strategy-family assembler; `netPnl = deltaPnl + fundingPnl −
 * feeCost` by construction.
 */
export function assembleTradeRecord(facts: TradeFacts): PnlRecord {
  const shared = {
    intentId: facts.intentId,
    exitReason: facts.exitReason,
    errorCode: facts.errorCode,
    fundingReceived: facts.fundingReceived,
    tDropOffsetS: facts.tDropOffsetS,
    holdDurationS: holdDurationS(facts),
  }
  if (facts.errorCode !== undefined) {
    return { ...shared, deltaPnl: 0, fundingPnl: 0, feeCost: 0, netPnl: 0, fillCount: 0 }
  }
  const assembler = ASSEMBLERS.get(facts.strategyId)
  if (assembler === undefined) throw new Error(`trade-record: no assembler for strategy '${facts.strategyId}'`)
  const { deltaPnl, fundingPnl, feeCost: derivedFee } = assembler(facts)
  // Reconciliation (0400) re-runs this over venue-corrected facts: a `feeCostOverride` books the
  // venue's realized fee verbatim (venue is truth for money, `15` §2) in place of the config-percent
  // geometry; `netPnl` stays `deltaPnl + fundingPnl − feeCost` by construction.
  const fee = facts.feeCostOverride ?? derivedFee
  return {
    ...shared,
    pEntry: facts.pEntry,
    pExit: facts.pExit,
    pAvg: facts.pAvg,
    deltaPnl,
    fundingPnl,
    feeCost: fee,
    netPnl: deltaPnl + fundingPnl - fee,
    fillCount: facts.fillCount,
  }
}
