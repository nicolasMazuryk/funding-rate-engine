/**
 * Funding-fee tracker (`11_execution_and_account_state.md` §7; `15` §G-R funding
 * booking). Records every `FundingFeeAccrued` the private stream publishes (0220) —
 * signed `amount` (quote currency) + `fundingTime` — keyed by symbol. Keeps unmatched
 * accruals as-is; the ±5 s intent-gate matching against `T_settle` is the funding gate's
 * job (0290), not here. `backfill` delegates to REST `fundingHistory` for reconciliation
 * (0400).
 *
 * Venue-neutral (`src/execution/`, not the pure core): holds mutable state, reads the
 * `ExchangeAdapter` port. Mirrors the tracker factory idiom — closure over deps,
 * `bus.subscribe` → `Unsubscribe`, `dispose()`. No WAL (the venue is the ground truth).
 */

import type { FundingFeeAccrued } from '../core/events/types.js'
import type { EventBus, Unsubscribe } from '../core/ports/bus.js'
import type { ExchangeAdapter, FundingEvent, TimeRange } from '../core/ports/exchange-adapter.js'

/** One booked funding accrual — the venue's `funding_fee` credit/charge (`00_globals.md` §1.1 `T_drop`). */
export interface FundingAccrual {
  /** Quote-currency (USDT) amount; signed — credit positive, charge negative. */
  readonly amount: number
  /** `T_drop`, epoch ms UTC. */
  readonly fundingTime: number
}

export interface FundingTrackerDeps {
  readonly bus: EventBus
  /** REST funding history for backfill/reconciliation (`15` §G-R, 0400). */
  readonly exchange: Pick<ExchangeAdapter, 'fundingHistory'>
}

export interface FundingTracker {
  /** Accruals booked for `symbol`, in arrival order; empty when none seen. */
  accrualsFor(symbol: string): readonly FundingAccrual[]
  /** REST-backfill settled funding for `symbol` over `range` (reconciliation, delegates to `fundingHistory`). */
  backfill(symbol: string, range: TimeRange): Promise<FundingEvent[]>
  /** Stop consuming the bus (adapter close). */
  dispose(): void
}

export function createFundingTracker(deps: FundingTrackerDeps): FundingTracker {
  const { bus, exchange } = deps
  const accruals = new Map<string, FundingAccrual[]>()

  function onFundingFeeAccrued(event: FundingFeeAccrued): void {
    const list = accruals.get(event.symbol) ?? []
    list.push({ amount: event.amount, fundingTime: event.fundingTime })
    accruals.set(event.symbol, list)
  }

  const unsubscribe: Unsubscribe = bus.subscribe((event) => {
    if (event.type === 'FundingFeeAccrued') onFundingFeeAccrued(event)
  })

  return {
    accrualsFor(symbol: string): readonly FundingAccrual[] {
      return accruals.get(symbol) ?? []
    },
    backfill(symbol: string, range: TimeRange): Promise<FundingEvent[]> {
      return exchange.fundingHistory(symbol, range)
    },
    dispose(): void {
      unsubscribe()
    },
  }
}
