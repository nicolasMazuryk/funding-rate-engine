/**
 * Entry-leg `placeOrder` spies over a {@link SimExchange} (task 0180 cleanup). The
 * crash tests wrapped the sim two ways — count entry orders, or hang them forever —
 * to prove recovery re-submits exactly once. Both wrappers spread the sim so every
 * other call still hits the real venue; only the `-entry-` leg is intercepted.
 */

import type { SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import type { OrderAck, OrderRequest } from '../../src/core/ports/exchange-adapter.js'

const isEntryLeg = (req: OrderRequest): boolean => req.clientOrderId.includes('-entry-')

export interface EntryOrderSpy {
  /** The wrapped exchange to hand the engine. */
  readonly exchange: SimExchange
  /** How many entry-leg orders have been placed through the spy. */
  count(): number
}

/** Wrap `sim` counting every entry-leg order placed (fills still go through). */
export function spyEntryOrders(sim: SimExchange): EntryOrderSpy {
  let entryOrders = 0
  const exchange: SimExchange = {
    ...sim,
    placeOrder(req: OrderRequest): Promise<OrderAck> {
      if (isEntryLeg(req)) entryOrders += 1
      return sim.placeOrder(req)
    },
  }
  return { exchange, count: () => entryOrders }
}

/** Wrap `sim` so entry-leg orders hang forever (the venue never sees them). */
export function hangEntryOrders(sim: SimExchange): SimExchange {
  return {
    ...sim,
    placeOrder(req: OrderRequest): Promise<OrderAck> {
      if (isEntryLeg(req)) return new Promise<OrderAck>(() => {})
      return sim.placeOrder(req)
    },
  }
}
