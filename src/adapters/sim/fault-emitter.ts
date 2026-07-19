/**
 * Generic stream-fault wrapper for the sim adapter (task 0160). Every event the sim
 * would `bus.publish(...)` is routed through {@link FaultEmitter.emit} instead, so a
 * scenario can drop, duplicate, delay, or reorder *any* event type without the sim
 * knowing which fault applies — the `13` §6 rows "WS silence", "duplicate OrderUpdate",
 * "out-of-order OrderUpdate", and "late/absent funding fee" all reduce to one of the
 * four actions below.
 *
 * Determinism is absolute (`0000` §5): `drop`/`duplicate`/`hold` key off an emit
 * ordinal, `delay` off `clock.now()` via {@link ../../core/ports/clock.js}.Clock — never
 * randomness. A `hold` action stashes the event and re-publishes it after N later
 * emits, producing genuine out-of-order arrival; a `delay` re-schedules it on the
 * virtual clock, which can still preserve order.
 */

import type { EngineEvent } from '../../core/events/types.js'
import type { EventBus } from '../../core/ports/bus.js'
import type { Clock } from '../../core/ports/clock.js'

/** Which logical WS lane an event belongs to (`10`/`11` §7 public vs private). */
export type StreamChannel = 'public' | 'private'

/** What a matched {@link FaultRule} does to the event. */
export type FaultAction = 'drop' | 'duplicate' | { readonly delayMs: number } | { readonly holdForEmits: number }

/** A scripted stream fault: match some events, act on the next `count` of them. */
export interface FaultRule {
  matches(event: EngineEvent, channel: StreamChannel): boolean
  readonly action: FaultAction
  /** Remaining matching events to act on; decremented per hit (`Infinity` for open windows). */
  count: number
}

export interface FaultEmitter {
  /** Publish `event` unless a rule intercepts it; derives the channel from the event type. */
  emit(event: EngineEvent): void
  addRule(rule: FaultRule): void
}

/** Public lane = market data; everything else the sim emits is private (account) lane. */
function channelOf(event: EngineEvent): StreamChannel {
  switch (event.type) {
    case 'MarketTick':
    case 'FundingPredicted':
    case 'FundingSettled':
      return 'public'
    default:
      return 'private'
  }
}

export function createFaultEmitter(bus: EventBus, clock: Clock): FaultEmitter {
  const rules: FaultRule[] = []
  const held: { readonly event: EngineEvent; readonly releaseAt: number }[] = []
  let ordinal = 0

  /** Flush any held events whose release ordinal has arrived (FIFO, out-of-order by design). */
  function flushHeld(): void {
    for (let i = held.length - 1; i >= 0; i--) {
      const entry = held[i]
      if (entry !== undefined && entry.releaseAt <= ordinal) {
        held.splice(i, 1)
        bus.publish(entry.event)
      }
    }
  }

  function apply(action: FaultAction, event: EngineEvent): void {
    if (action === 'drop') return
    if (action === 'duplicate') {
      bus.publish(event)
      bus.publish(event)
      return
    }
    if ('delayMs' in action) {
      clock.scheduleTimer(clock.now() + action.delayMs, () => bus.publish(event))
      return
    }
    held.push({ event, releaseAt: ordinal + action.holdForEmits })
  }

  return {
    emit(event: EngineEvent): void {
      ordinal += 1
      const channel = channelOf(event)
      const rule = rules.find((r) => r.count > 0 && r.matches(event, channel))
      if (rule) {
        rule.count -= 1
        apply(rule.action, event)
      } else {
        bus.publish(event)
      }
      flushHeld()
    },
    addRule(rule: FaultRule): void {
      rules.push(rule)
    },
  }
}
