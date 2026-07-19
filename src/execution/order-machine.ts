/**
 * Order finite-state machine (`11_execution_and_account_state.md` §6), built on
 * the shared engine (`src/core/intent/fsm-engine.ts`, `08` §5).
 *
 * This is the pure state table + types only — driven by `OrderUpdate` events,
 * its terminal states feed the intent FSM (`12`). Live wiring (submit/ack/fill
 * from the venue) lands with the order manager in task 0230. The file lives
 * under `src/execution/` but imports **no** I/O: the engine is core, the types
 * are plain data, so `order-machine.ts` is importable anywhere.
 */

import { defineMachine } from '../core/intent/fsm-engine.js'

/** The nine order states (`11` §6 diagram + table). */
export type OrderState =
  | 'NEW'
  | 'SUBMITTING'
  | 'OPEN'
  | 'FILLED'
  | 'PARTIAL'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'FAILED'

/**
 * Legal transitions (`11` §6). `PARTIAL` is a distinct state (ladders / large
 * orders) that keeps its filled qty through to `FILLED` or `CANCELLED` — carried
 * on {@link OrderPayload.filledQty}, not modeled as extra states.
 */
const ORDER_TRANSITIONS = {
  NEW: ['SUBMITTING', 'FAILED'],
  SUBMITTING: ['OPEN', 'REJECTED'],
  OPEN: ['FILLED', 'PARTIAL', 'CANCELLED', 'EXPIRED'],
  PARTIAL: ['FILLED', 'CANCELLED'],
  FILLED: [],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED: [],
  FAILED: [],
} as const satisfies { readonly [S in OrderState]: readonly OrderState[] }

/**
 * Data carried through an order's transitions. `filledQty` accumulates on
 * `PARTIAL` and survives into `FILLED` / `CANCELLED` (`11` §6, "keeps filled
 * qty"); base-asset units. Absent until the first partial fill.
 */
export type OrderPayload = {
  readonly filledQty?: number
}

export const orderMachine = defineMachine<typeof ORDER_TRANSITIONS, OrderPayload>({
  name: 'order',
  transitions: ORDER_TRANSITIONS,
})

/**
 * Transition an order. Thin wrapper over the engine's `transition` for symmetry
 * with the intent FSM; the order FSM has no cross-registry rule to enforce, so
 * it just forwards (payload passthrough carries `filledQty`).
 */
export function transitionOrder<From extends OrderState>(
  from: From,
  to: (typeof ORDER_TRANSITIONS)[From][number],
  payload: OrderPayload = {},
): OrderPayload {
  return orderMachine.transition(from, to, payload)
}
