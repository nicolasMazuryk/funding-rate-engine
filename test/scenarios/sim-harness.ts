/**
 * Minimal sim-only harness for scenarios that exercise the venue directly (task 0160
 * plan §3 ASSUMPTION: venue-error and resting-order faults are driven via direct
 * `sim.*()` calls, not through the engine — routing a scripted rejection through the
 * fire-and-forget engine `placeOrder` would risk an unhandled rejection; that wiring
 * is 0200's job). Wires a sim venue to a real bus + virtual clock and collects every
 * published event, so a scenario asserts on the exact stream the client would see.
 */

import { createVirtualClock, type VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { EngineEvent } from '../../src/core/events/types.js'
import type { EventBus } from '../../src/core/ports/bus.js'

export interface SimHarness {
  readonly clock: VirtualClock
  readonly bus: EventBus
  readonly sim: SimExchange
  readonly events: readonly EngineEvent[]
}

export function simHarness(startMs = 0): SimHarness {
  const clock = createVirtualClock(startMs)
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))
  const sim = createSimExchange(clock, bus)
  return { clock, bus, sim, events }
}
