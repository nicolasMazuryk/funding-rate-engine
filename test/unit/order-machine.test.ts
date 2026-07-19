import { describe, expect, it } from 'vitest'
import { IllegalTransitionError } from '../../src/core/intent/fsm-engine.js'
import { type OrderState, orderMachine, transitionOrder } from '../../src/execution/order-machine.js'

/** Legal edges mirrored from `11` §6 for exhaustive iteration + random walks. */
const LEGAL: { readonly [S in OrderState]: readonly OrderState[] } = {
  NEW: ['SUBMITTING', 'FAILED'],
  SUBMITTING: ['OPEN', 'REJECTED'],
  OPEN: ['FILLED', 'PARTIAL', 'CANCELLED', 'EXPIRED'],
  PARTIAL: ['FILLED', 'CANCELLED'],
  FILLED: [],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED: [],
  FAILED: [],
}

const ALL_STATES = Object.keys(LEGAL) as OrderState[]

describe('order FSM — legal transitions', () => {
  for (const from of ALL_STATES) {
    for (const to of LEGAL[from]) {
      it(`allows ${from} → ${to}`, () => {
        expect(() => transitionOrder(from, to as never)).not.toThrow()
      })
    }
  }
})

describe('order FSM — illegal transitions throw naming both states', () => {
  const illegal: ReadonlyArray<readonly [OrderState, OrderState]> = [
    ['NEW', 'OPEN'],
    ['SUBMITTING', 'FILLED'],
    ['OPEN', 'SUBMITTING'],
    ['PARTIAL', 'OPEN'],
    ['FILLED', 'OPEN'],
    ['CANCELLED', 'OPEN'],
    ['EXPIRED', 'OPEN'],
    ['REJECTED', 'OPEN'],
    ['FAILED', 'OPEN'],
  ]
  for (const [from, to] of illegal) {
    it(`rejects ${from} → ${to}`, () => {
      expect(() => orderMachine.transition(from, to as never, {})).toThrowError(IllegalTransitionError)
      try {
        orderMachine.transition(from, to as never, {})
        expect.unreachable('should throw')
      } catch (err) {
        const e = err as IllegalTransitionError
        expect(e.from).toBe(from)
        expect(e.to).toBe(to)
        expect(e.machine).toBe('order')
      }
    })
  }
})

describe('order FSM — PARTIAL retains filledQty through to terminal', () => {
  it('carries filledQty from PARTIAL to FILLED', () => {
    const result = transitionOrder('PARTIAL', 'FILLED', { filledQty: 0.75 })
    expect(result.filledQty).toBe(0.75)
  })

  it('carries filledQty from PARTIAL to CANCELLED', () => {
    const result = transitionOrder('PARTIAL', 'CANCELLED', { filledQty: 0.5 })
    expect(result.filledQty).toBe(0.5)
  })
})

describe('order FSM — random-walk terminal uniqueness (17 §2)', () => {
  it('no legal walk reaches two terminal states', () => {
    let seed = 0x1234abcd
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let run = 0; run < 500; run++) {
      let state: OrderState = 'NEW'
      let terminalsSeen = 0
      let steps = 0
      while (steps++ < 20) {
        if (orderMachine.isTerminal(state)) {
          terminalsSeen++
          break
        }
        const next = LEGAL[state]
        state = next[Math.floor(rand() * next.length)] as OrderState
      }
      expect(orderMachine.isTerminal(state)).toBe(true)
      expect(terminalsSeen).toBe(1)
    }
  })
})
