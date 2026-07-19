/**
 * The one shared FSM engine (`08_system_overview.md` §5).
 *
 * A table lookup with a transition hook — not a framework. Two state tables
 * drive it: the intent FSM ({@link ./intent-machine.ts}, `12` §5) and the order
 * FSM (`src/execution/order-machine.ts`, `11` §6). DRY: no second FSM anywhere.
 *
 * Purity: this is pure core — a legal-transition set plus a synchronous observer.
 * The observer fires *after* validation and *before* the caller commits the new
 * state, which is the point where task 0070 appends the transition to the WAL
 * (WAL-before-side-effect, `14` §2.1). The engine itself performs no I/O.
 */

/**
 * A transition table: each state maps to the states it may legally move to.
 * A terminal state maps to `[]` (readonly empty tuple → `never` when indexed),
 * which makes `transition('CLOSED', …)` a compile error where `from` is a
 * literal — no per-state overloads needed.
 */
export type TransitionTable = { readonly [state: string]: readonly string[] }

/** Observer fired synchronously after validation, before commit (the WAL gate). */
export type TransitionObserver<S extends string, Payload> = (transition: {
  readonly from: S
  readonly to: S
  readonly payload: Payload
}) => void

/** Unsubscribe handle returned by {@link Machine.onTransition}. */
export type Unsubscribe = () => void

/**
 * Thrown when `to` is not in `from`'s allowed list at runtime. Guards dynamic /
 * non-literal calls the type system cannot catch. Carries both states and the
 * machine name for diagnosis.
 */
export class IllegalTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`[${machine}] illegal transition: ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export interface Machine<T extends TransitionTable, Payload> {
  readonly name: string
  /**
   * Validate `from → to`, fire observers, and return the payload unchanged.
   * `to` is typed as `T[From][number]`, so an illegal target is a compile error
   * where `from` is statically known; the runtime check backstops dynamic calls.
   */
  transition<From extends keyof T & string>(from: From, to: T[From][number] & string, payload: Payload): Payload
  /** Whether `state` is terminal (no outgoing transitions). */
  isTerminal(state: keyof T & string): boolean
  /** Register a transition observer; returns an unsubscribe handle. */
  onTransition(observer: TransitionObserver<keyof T & string, Payload>): Unsubscribe
}

/**
 * Build a machine from a transition table. `terminalStates` is derived from the
 * table (states whose allowed list is empty) — passing it is unnecessary, so the
 * engine computes it and stays a single source of truth.
 */
export function defineMachine<T extends TransitionTable, Payload = void>({
  name,
  transitions,
}: {
  readonly name: string
  readonly transitions: T
}): Machine<T, Payload> {
  const observers = new Set<TransitionObserver<keyof T & string, Payload>>()

  return {
    name,
    transition(from, to, payload) {
      const allowed = transitions[from]
      if (allowed === undefined || !allowed.includes(to)) {
        throw new IllegalTransitionError(name, from, to)
      }
      for (const observer of observers) {
        observer({ from, to: to as keyof T & string, payload })
      }
      return payload
    },
    isTerminal(state) {
      const allowed = transitions[state]
      return allowed !== undefined && allowed.length === 0
    },
    onTransition(observer) {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    },
  }
}
