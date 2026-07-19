/**
 * Minimal composition entry for the walking skeleton (task 0090/0130) — the "wire
 * the concretes and hand the engine its ports" step, usable from tests. NOT the
 * full `main.ts` (that is a later task): it lives under `test/helpers/` because the
 * spec `08` §7 layout has no slot for generic composition yet (decision #2).
 *
 * Constructs the sim venue, WAL, repo, scheduler, strategy registry, and engine,
 * taps the bus for the `events.jsonl` trace, and routes reconciliation findings to
 * the logger. Any of clock/bus/exchange/repo can be injected so crash-recovery
 * tests share one venue + clock across two engine instances (a simulated crash
 * keeps venue state but drops the engine's in-memory maps).
 */

import type { Logger } from 'pino'
import { createVirtualClock, type VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { EventBus } from '../../src/core/ports/bus.js'
import type { Repo } from '../../src/core/ports/repo.js'
import { createEngine, type Engine, type ReconciliationRecord } from '../../src/core/runtime/engine.js'
import { createScheduler, type Scheduler } from '../../src/core/runtime/scheduler.js'
import {
  createStrategyRegistry,
  type RuntimeStrategyConfig,
  type StrategyRegistry,
} from '../../src/core/strategies/registry.js'
import { createStubStrategy, type StubStrategyConfig } from '../../src/core/strategies/stub.js'
import { createWalFile, type WalFile } from '../../src/persistence/wal/wal-file.js'
import { createInMemoryRepo } from './in-memory-repo.js'
import { createLogger } from './logger.js'
import { createTraceWriter, type TraceWriter } from './trace-writer.js'

/** Fixed stub-strategy build config for the skeleton (the module's own id/threshold/etc). */
export const DEFAULT_STUB_CONFIG: StubStrategyConfig = {
  id: 's1',
  negativeFundingThresholdPercent: -0.3,
  entryOffsetSeconds: 90,
  holdMs: 300_000,
  entryQty: 0.01,
}

/** The engine-facing runtime config, derived from {@link DEFAULT_STUB_CONFIG}. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: DEFAULT_STUB_CONFIG.id,
  thresholdPercent: DEFAULT_STUB_CONFIG.negativeFundingThresholdPercent,
  direction: 'negative',
  entryOffsetSeconds: DEFAULT_STUB_CONFIG.entryOffsetSeconds,
  holdMs: DEFAULT_STUB_CONFIG.holdMs,
  entryQty: DEFAULT_STUB_CONFIG.entryQty,
}

export interface BuildOpts {
  readonly walPath: string
  /** When set, the `events.jsonl` trace writer is attached to the bus. */
  readonly eventsPath?: string
  readonly startMs?: number
  readonly clock?: VirtualClock
  readonly bus?: EventBus
  readonly exchange?: SimExchange
  readonly repo?: Repo
  readonly registry?: StrategyRegistry
  readonly strategyConfig?: RuntimeStrategyConfig
  readonly preflight?: () => boolean
  readonly onReconciliation?: (record: ReconciliationRecord) => void
  readonly logger?: Logger
}

export interface SkeletonHarness {
  readonly clock: VirtualClock
  readonly bus: EventBus
  readonly exchange: SimExchange
  readonly wal: WalFile
  readonly repo: Repo
  readonly scheduler: Scheduler
  readonly engine: Engine
  readonly registry: StrategyRegistry
  readonly strategyConfig: RuntimeStrategyConfig
  readonly traceWriter?: TraceWriter
  readonly logger: Logger
}

export function buildSkeletonEngine(opts: BuildOpts): SkeletonHarness {
  const clock = opts.clock ?? createVirtualClock(opts.startMs ?? 0)
  const bus = opts.bus ?? createEventBus()
  const exchange = opts.exchange ?? createSimExchange(clock, bus)
  const wal = createWalFile({ path: opts.walPath })
  const repo = opts.repo ?? createInMemoryRepo()
  const registry = opts.registry ?? createStrategyRegistry([createStubStrategy(DEFAULT_STUB_CONFIG)])
  const strategyConfig = opts.strategyConfig ?? DEFAULT_RUNTIME_CONFIG
  const logger = opts.logger ?? createLogger({ instance: 'skeleton' })
  const scheduler = createScheduler(clock, bus)

  const traceWriter = opts.eventsPath === undefined ? undefined : createTraceWriter({ path: opts.eventsPath })
  if (traceWriter) bus.subscribe((event) => traceWriter.record(event))

  const onReconciliation =
    opts.onReconciliation ??
    ((record: ReconciliationRecord) => logger.info({ reconciliation: record }, 'reconciliation'))

  const engine = createEngine({
    bus,
    clock,
    scheduler,
    exchange,
    wal,
    repo,
    registry,
    strategyConfig,
    preflight: opts.preflight,
    onReconciliation,
  })

  return { clock, bus, exchange, wal, repo, scheduler, engine, registry, strategyConfig, traceWriter, logger }
}
