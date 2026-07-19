import { describe, expect, it, vi } from 'vitest'
import { defineMachine, IllegalTransitionError } from '../../src/core/intent/fsm-engine.js'

/**
 * The generic engine, tested through a tiny two-terminal machine so the
 * behavior — legal-transition guard, terminal query, observer hook — is
 * exercised independently of the intent/order tables that drive it in prod.
 */
const TRAFFIC = {
  RED: ['GREEN'],
  GREEN: ['YELLOW'],
  YELLOW: ['RED', 'OFF'],
  OFF: [],
} as const

type Payload = { readonly note: string }

function makeMachine() {
  return defineMachine<typeof TRAFFIC, Payload>({ name: 'traffic', transitions: TRAFFIC })
}

// Negative-compile evidence (verification step 3): with `from` a literal, the
// engine types `to` as `T[From][number]`, so an illegal target is a compile
// error — no runtime call needed to reject it. Uncommenting either line fails
// `tsc --noEmit`:
//   makeMachine().transition('RED', 'YELLOW', { note: 'x' }) // TS2345: 'YELLOW' not assignable to 'GREEN'
//   makeMachine().transition('OFF', 'RED', { note: 'x' })    // TS2345: arg not assignable to 'never' (OFF terminal)

describe('defineMachine', () => {
  it('allows a legal transition and returns the payload unchanged', () => {
    const m = makeMachine()
    const payload = { note: 'go' }
    expect(m.transition('RED', 'GREEN', payload)).toBe(payload)
  })

  it('throws IllegalTransitionError naming both states on an illegal transition', () => {
    const m = makeMachine()
    // Cast through `never`: the static type already forbids RED → YELLOW (see the
    // commented compile-error note below); this exercises the runtime guard for
    // dynamic callers the type system can't reach.
    expect(() => m.transition('RED', 'YELLOW' as never, { note: 'x' })).toThrowError(IllegalTransitionError)
    try {
      m.transition('RED', 'YELLOW' as never, { note: 'x' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError)
      const e = err as IllegalTransitionError
      expect(e.from).toBe('RED')
      expect(e.to).toBe('YELLOW')
      expect(e.machine).toBe('traffic')
      expect(e.message).toContain('RED')
      expect(e.message).toContain('YELLOW')
    }
  })

  it('reports terminal states via isTerminal', () => {
    const m = makeMachine()
    expect(m.isTerminal('OFF')).toBe(true)
    expect(m.isTerminal('RED')).toBe(false)
    expect(m.isTerminal('YELLOW')).toBe(false)
  })

  it('fires the observer once per transition, after validation, before commit', () => {
    const m = makeMachine()
    const observer = vi.fn()
    m.onTransition(observer)

    m.transition('RED', 'GREEN', { note: 'go' })
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({ from: 'RED', to: 'GREEN', payload: { note: 'go' } })

    // An illegal transition throws before any observer runs.
    observer.mockClear()
    expect(() => m.transition('RED', 'YELLOW' as never, { note: 'x' })).toThrow()
    expect(observer).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const m = makeMachine()
    const observer = vi.fn()
    const unsubscribe = m.onTransition(observer)

    m.transition('RED', 'GREEN', { note: 'a' })
    expect(observer).toHaveBeenCalledTimes(1)

    unsubscribe()
    m.transition('GREEN', 'YELLOW', { note: 'b' })
    expect(observer).toHaveBeenCalledTimes(1)
  })
})
