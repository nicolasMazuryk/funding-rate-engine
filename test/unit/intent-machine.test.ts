import { describe, expect, it } from 'vitest'
import { IllegalTransitionError } from '../../src/core/intent/fsm-engine.js'
import {
  type ErrorCode,
  type ExitReason,
  type IntentState,
  intentMachine,
  transitionIntent,
} from '../../src/core/intent/intent-machine.js'

/** Legal edges mirrored from `12` §5 for exhaustive iteration + random walks. */
const LEGAL: { readonly [S in IntentState]: readonly IntentState[] } = {
  SELECTED: ['SUBMITTING_ENTRY', 'ABORTED'],
  SUBMITTING_ENTRY: ['MONITORING', 'ENTRY_FAILED', 'NO_POSITION'],
  MONITORING: ['EXITING', 'NO_POSITION'],
  EXITING: ['CLOSED'],
  CLOSED: [],
  ABORTED: [],
  ENTRY_FAILED: [],
  NO_POSITION: [],
}

const ALL_STATES = Object.keys(LEGAL) as IntentState[]

/** A payload that satisfies R12 for whichever terminal `to` is (or a non-terminal). */
function payloadFor(to: IntentState) {
  if (to === 'CLOSED') return { exitReason: 'timed' as ExitReason }
  if (to === 'ABORTED' || to === 'ENTRY_FAILED' || to === 'NO_POSITION') {
    return { errorCode: 'kill_switch' as ErrorCode }
  }
  return {}
}

describe('intent FSM — legal transitions', () => {
  for (const from of ALL_STATES) {
    for (const to of LEGAL[from]) {
      it(`allows ${from} → ${to}`, () => {
        expect(() => transitionIntent(from, to as never, payloadFor(to))).not.toThrow()
      })
    }
  }
})

describe('intent FSM — illegal transitions throw naming both states', () => {
  // One representative illegal target per state (dynamic call — engine runtime guard).
  const illegal: ReadonlyArray<readonly [IntentState, IntentState]> = [
    ['SELECTED', 'CLOSED'],
    ['SUBMITTING_ENTRY', 'CLOSED'],
    ['MONITORING', 'CLOSED'],
    ['EXITING', 'MONITORING'],
    ['CLOSED', 'MONITORING'],
    ['ABORTED', 'SELECTED'],
    ['ENTRY_FAILED', 'MONITORING'],
    ['NO_POSITION', 'MONITORING'],
  ]
  for (const [from, to] of illegal) {
    it(`rejects ${from} → ${to}`, () => {
      // Cast through `never`: this is the dynamic path the type system can't catch.
      expect(() => intentMachine.transition(from, to as never, {})).toThrowError(IllegalTransitionError)
      try {
        intentMachine.transition(from, to as never, {})
        expect.unreachable('should throw')
      } catch (err) {
        const e = err as IllegalTransitionError
        expect(e.from).toBe(from)
        expect(e.to).toBe(to)
      }
    })
  }
})

describe('intent FSM — every exit_reason is producible into CLOSED', () => {
  const exitReasons: readonly ExitReason[] = [
    'timed',
    'funding_fee_event',
    'funding_fee_timeout',
    'tp_hit',
    'sl_hit',
    'deadline',
    'kill_switch_flatten',
  ]
  for (const exitReason of exitReasons) {
    it(`CLOSED with exit_reason ${exitReason}`, () => {
      const result = transitionIntent('EXITING', 'CLOSED', { exitReason })
      expect(result.exitReason).toBe(exitReason)
      expect(result.errorCode).toBeUndefined()
    })
  }
})

describe('intent FSM — every error_code is producible into an error terminal', () => {
  // Each code paired with a legal error-terminal transition (`00_globals` §10.2).
  // S6's entry sub-machine spans SUBMITTING_ENTRY entirely (MONITORING begins only after
  // MAIN fill + net confirm), so all seven S6 terminals fire from SUBMITTING_ENTRY (0350).
  const cases: ReadonlyArray<readonly [ErrorCode, IntentState, IntentState]> = [
    ['kill_switch', 'SELECTED', 'ABORTED'],
    ['limit_expired', 'SUBMITTING_ENTRY', 'NO_POSITION'],
    ['ladder_no_fills', 'SUBMITTING_ENTRY', 'NO_POSITION'],
    ['pre_funding_order_failed', 'SUBMITTING_ENTRY', 'ENTRY_FAILED'],
    ['pre_funding_order_rejected', 'SUBMITTING_ENTRY', 'ENTRY_FAILED'],
    ['pre_funding_not_filled', 'SUBMITTING_ENTRY', 'NO_POSITION'],
    ['funding_event_timeout', 'SUBMITTING_ENTRY', 'NO_POSITION'],
    ['main_order_failed', 'SUBMITTING_ENTRY', 'ENTRY_FAILED'],
    ['main_order_rejected', 'SUBMITTING_ENTRY', 'ENTRY_FAILED'],
    ['close_pre_funding_failed', 'SUBMITTING_ENTRY', 'NO_POSITION'],
  ]
  for (const [errorCode, from, to] of cases) {
    it(`${to} with error_code ${errorCode}`, () => {
      const result = transitionIntent(from as never, to as never, { errorCode })
      expect(result.errorCode).toBe(errorCode)
      expect(result.exitReason).toBeUndefined()
    })
  }
})

describe('intent FSM — R12 payload enforcement', () => {
  it('CLOSED without an exit_reason throws', () => {
    expect(() => transitionIntent('EXITING', 'CLOSED', {})).toThrowError(/requires an exitReason/)
  })

  it('CLOSED carrying an error_code throws', () => {
    // Type-valid payload (matches the errorCode variant); rejected at runtime for CLOSED (R12).
    expect(() => transitionIntent('EXITING', 'CLOSED', { errorCode: 'kill_switch' })).toThrow()
  })

  for (const to of ['ABORTED', 'ENTRY_FAILED', 'NO_POSITION'] as const) {
    const from: IntentState = to === 'ABORTED' ? 'SELECTED' : 'SUBMITTING_ENTRY'
    it(`${to} without an error_code throws`, () => {
      expect(() => transitionIntent(from as never, to as never, {})).toThrowError(/requires an errorCode/)
    })
  }

  it('an error terminal carrying an exit_reason throws', () => {
    // Type-valid payload (matches the exitReason variant); rejected at runtime for NO_POSITION (R12).
    expect(() => transitionIntent('MONITORING', 'NO_POSITION', { exitReason: 'timed' })).toThrow()
  })
})

describe('intent FSM — random-walk terminal uniqueness (17 §2)', () => {
  it('no legal walk reaches two terminal states', () => {
    // Deterministic pseudo-random walks (no Math.random — seeded LCG for repeatability).
    let seed = 0x9e3779b9
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let run = 0; run < 500; run++) {
      let state: IntentState = 'SELECTED'
      let terminalsSeen = 0
      let steps = 0
      while (steps++ < 20) {
        if (intentMachine.isTerminal(state)) {
          terminalsSeen++
          break // engine forbids leaving a terminal — walk ends here
        }
        const next = LEGAL[state]
        state = next[Math.floor(rand() * next.length)] as IntentState
      }
      expect(intentMachine.isTerminal(state)).toBe(true)
      expect(terminalsSeen).toBe(1)
    }
  })
})
