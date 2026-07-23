/**
 * The `sl_tp_deadline` exit policy (`04_strategy_3a.md` §3) — pure core. S3a's exit and the
 * reusable base S4.1a (0330) / S4.2a (0340) extend with their own geometry: on entry fill a
 * protective OCO pair is placed — a resting SL stop-market and a resting TP limit, both
 * reduce-only — bounded by a deadline market close. First fill cancels the sibling (the
 * engine's post-exit sweep); the deadline cancels both.
 *
 * Simpler than S2's retracement policy: no funding gate, no trailing. Both legs are **static**
 * and placed once on arming; the only price math is the SL trigger and TP limit, injected as
 * {@link SlTpDeadlineGeometry} callbacks so each variant supplies its own formula while the
 * lifecycle (place / OCO close / deadline) lives here once.
 *
 * Legs are placed/cancelled through the engine's {@link ExitPolicyContext} order-command seam
 * (`placeExitLeg`/`confirmClose` for the resting SL/TP; `requestExit` for the deadline market).
 * Prices are emitted raw; the engine rounds them at the edge (`roundPrice`).
 */

import type { RuntimeStrategyConfig } from '../../strategies/registry.js'
import type { ExitPolicyContext, ExitPolicyHandler, ExitPolicyKind, MonitoredIntent } from '../exit-policy.js'

/**
 * The per-variant price math the handler is parameterized by (`04` §3, and 0330/0340). Each
 * callback returns a raw price the engine rounds; a missing config key is a fail-loud throw
 * inside the callback (the geometry owns its own required-param validation).
 */
export interface SlTpDeadlineGeometry {
  /** Stop-market trigger price (reduce-only SL). */
  slPrice(intent: MonitoredIntent, config: RuntimeStrategyConfig): number
  /** Limit price (reduce-only TP, maker). */
  tpPrice(intent: MonitoredIntent, config: RuntimeStrategyConfig): number
}

/** Live per-intent handler state: the resting-leg client order ids the OCO close routes against. */
interface LegRecord {
  slCoid?: string
  tpCoid?: string
}

/**
 * Build a `sl_tp_deadline` handler for the given price geometry. The lifecycle (place the OCO
 * pair on arming, schedule the deadline, route a leg fill to the OCO close) is identical across
 * S3a/S4.\*a; only {@link SlTpDeadlineGeometry} differs.
 */
export function createSlTpDeadlineHandler(
  geometry: SlTpDeadlineGeometry,
  kind: ExitPolicyKind = 'sl_tp_deadline',
): ExitPolicyHandler {
  const records = new Map<string, LegRecord>()

  return {
    kind,

    arm(intent, config, ctx): number {
      if (intent.entryFillPx === undefined) {
        throw new Error(`SL_TP_DEADLINE_HANDLER: intent '${intent.intentId}' has no entryFillPx for the OCO legs`)
      }
      if (intent.settleTs === undefined) {
        throw new Error(`SL_TP_DEADLINE_HANDLER: intent '${intent.intentId}' has no settleTs to arm against`)
      }
      if (config.deadlineSeconds === undefined) {
        throw new Error(`SL_TP_DEADLINE_HANDLER: intent '${intent.intentId}' config has no deadlineSeconds`)
      }
      const qty = intent.entryFillQty ?? intent.entryQty
      // SL stop-market + TP limit, both reduce-only, active immediately from the entry fill (`04` §2 step 2).
      const slCoid = ctx.placeExitLeg(intent.intentId, {
        leg: 'sl',
        attempt: 1,
        type: 'stop',
        price: geometry.slPrice(intent, config),
        qty,
      })
      const tpCoid = ctx.placeExitLeg(intent.intentId, {
        leg: 'tp',
        attempt: 1,
        type: 'limit',
        price: geometry.tpPrice(intent, config),
        qty,
      })
      // Deadline keyed to T_settle (recovery reuses the persisted instant), cancels both legs.
      const deadlineMs = intent.deadlineMs ?? intent.settleTs + config.deadlineSeconds * 1000
      ctx.scheduleDeadline(intent.intentId, deadlineMs)
      records.set(intent.intentId, { slCoid, tpCoid })
      return deadlineMs
    },

    onEvent(event, intent, _config, ctx): undefined {
      // The only MONITORING event this policy acts on is its deadline Timer — the static legs
      // rest untouched until a fill or the deadline. Market ticks/funding fees are ignored.
      if (event.type === 'Timer' && event.kind === 'deadline' && event.intentId === intent.intentId) {
        if (!records.has(intent.intentId)) return undefined
        records.delete(intent.intentId)
        // Fire the market reduce-only; the resting SL/TP are swept on `→ CLOSED`.
        ctx.requestExit(intent.intentId, 'deadline')
      }
      return undefined
    },

    onOrderUpdate(event, intent, _config, ctx): void {
      const rec = records.get(intent.intentId)
      if (rec === undefined || event.status !== 'FILLED') return
      const leg =
        event.clientOrderId === rec.slCoid ? 'sl_hit' : event.clientOrderId === rec.tpCoid ? 'tp_hit' : undefined
      if (leg === undefined) return // an update on a since-cancelled leg — ignore
      records.delete(intent.intentId)
      // OCO close: the fill already flattened; `confirmClose` records CLOSED and sweeps the sibling.
      ctx.confirmClose(intent.intentId, leg, event.clientOrderId)
    },
  }
}

/** Per-variant TP price math for the ladder handler (`05` §3): a raw TP limit above `P_avg`. */
export interface LadderTpGeometry {
  /** TP limit from the current fill-weighted average (`P_avg × (1 + takeProfitPct/100)`). */
  tpPrice(pAvg: number, config: RuntimeStrategyConfig, ratePercent?: number): number
}

/** Live per-intent ladder handler state: the resting TP's client order id + its attempt counter. */
interface LadderRecord {
  tpCoid?: string
  tpAttempt: number
}

/**
 * Build the **ladder** variant of the `sl_tp_deadline` handler (S4.1a, `05` §2/§3). Unlike the
 * base handler it owns neither the SL (engine-side conditional stop, `conditional-stop.ts`) nor
 * the deadline (the engine schedules it in `SUBMITTING_ENTRY` so a zero-fill ladder can terminate
 * before this handler ever arms). It owns only the reduce-only TP, which is (re-)placed on every
 * rung fill via {@link ExitPolicyHandler.onEntryFill}: cancel the prior TP, place a fresh one
 * sized to the filled qty at the updated `P_avg`. A TP fill drives the OCO close; the deadline
 * routes to the market close via `requestExit`.
 */
export function createLadderSlTpDeadlineHandler(geometry: LadderTpGeometry): ExitPolicyHandler {
  const records = new Map<string, LadderRecord>()

  /** (Re-)place the TP for the current `P_avg`, cancelling any prior resting TP first. */
  function placeTp(intent: MonitoredIntent, config: RuntimeStrategyConfig, ctx: ExitPolicyContext): void {
    if (intent.entryFillPx === undefined) {
      throw new Error(`LADDER_SL_TP_DEADLINE: intent '${intent.intentId}' has no entryFillPx (P_avg) for the TP`)
    }
    const rec = records.get(intent.intentId) ?? { tpAttempt: 0 }
    if (rec.tpCoid !== undefined) ctx.cancelExitLeg(rec.tpCoid)
    rec.tpAttempt += 1
    rec.tpCoid = ctx.placeExitLeg(intent.intentId, {
      leg: 'tp',
      attempt: rec.tpAttempt,
      type: 'limit',
      price: geometry.tpPrice(intent.entryFillPx, config, intent.ratePercent),
      qty: intent.entryFillQty ?? intent.entryQty,
    })
    records.set(intent.intentId, rec)
  }

  return {
    kind: 'sl_tp_deadline',

    arm(intent): number | undefined {
      // Ladder: the SL (engine conditional stop) + the deadline are already armed/scheduled by the
      // engine at placement time; the TP is placed by `onEntryFill`. Return the engine's deadline.
      return intent.deadlineMs
    },

    onEntryFill(intent, config, ctx): void {
      placeTp(intent, config, ctx)
    },

    onEvent(event, intent, _config, ctx): undefined {
      if (event.type === 'Timer' && event.kind === 'deadline' && event.intentId === intent.intentId) {
        records.delete(intent.intentId)
        ctx.requestExit(intent.intentId, 'deadline')
      }
      return undefined
    },

    onOrderUpdate(event, intent, _config, ctx): void {
      const rec = records.get(intent.intentId)
      if (rec === undefined || event.status !== 'FILLED' || event.clientOrderId !== rec.tpCoid) return
      records.delete(intent.intentId)
      // OCO close: the TP fill already flattened; `confirmClose` records CLOSED and sweeps siblings.
      ctx.confirmClose(intent.intentId, 'tp_hit', event.clientOrderId)
    },
  }
}
