/**
 * Minimal composition entry for the walking skeleton (task 0090/0130/0170) — the
 * "wire the concretes and hand the engine its ports" step. NOT the full `main.ts`
 * (that is a later task). It moved from `test/helpers/` to `src/replay/` in task
 * 0170 so non-test callers (`scripts/replay.ts`, the replay engine) can reuse it
 * without importing test code — production code must not depend on test code
 * (same rule stated in `src/config/revision-hash.ts`). The old test-helper path
 * (`test/helpers/build-skeleton-engine.ts`) is now a thin re-export, so existing
 * test imports keep working unchanged.
 *
 * Constructs the sim venue, WAL, repo, scheduler, strategy registry, and engine.
 * When `tracePath` is set it attaches the unified trace writer (`trace-file.ts`):
 * one JSONL artifact holding the config header, every bus `event`, and every WAL
 * `transition` — replacing task 0090's separate WAL/event trace files. Any of
 * clock/bus/exchange/repo/scheduler can be injected so crash-recovery tests share
 * one venue + clock across two engine instances, and the replay engine can swap
 * in inert ports.
 */

import type { Logger } from 'pino'
import { createVirtualClock, type VirtualClock } from '../adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../adapters/sim/sim-exchange.js'
import { computeConfigRevisionHash } from '../config/revision-hash.js'
import { createEventBus } from '../core/events/bus.js'
import type { EventBus } from '../core/ports/bus.js'
import type { Balance } from '../core/ports/exchange-adapter.js'
import type { Repo } from '../core/ports/repo.js'
import type { RiskGate } from '../core/ports/risk-gate.js'
import type { TransitionLog, TransitionLogEntry } from '../core/ports/transition-log.js'
import { createEngine, type Engine, type ReconciliationRecord } from '../core/runtime/engine.js'
import { createScheduler, type Scheduler } from '../core/runtime/scheduler.js'
import {
  createStrategyRegistry,
  type RuntimeStrategyConfig,
  type StrategyRegistry,
} from '../core/strategies/registry.js'
import { createStubStrategy, type StubStrategyConfig } from '../core/strategies/stub.js'
import { createWalFile, type WalFile } from '../persistence/wal/wal-file.js'
import { createRiskGate } from '../risk/gate.js'
import { createKillSwitch, type KillSwitch } from '../risk/kill-switch.js'
import { createInMemoryRepo } from './in-memory-repo.js'
import { createLogger } from './logger.js'
import { createTraceFile, type TraceFile } from './trace-file.js'

/** Fixed stub-strategy build config for the skeleton (the module's own id/threshold/etc). */
export const DEFAULT_STUB_CONFIG: StubStrategyConfig = {
  id: 's1',
  negativeFundingThresholdPercent: -0.3,
  entryOffsetSeconds: 90,
  holdMs: 300_000,
  entryQty: 0.01,
}

/**
 * The engine-facing runtime config, derived from {@link DEFAULT_STUB_CONFIG}.
 * `amountUsd: 50` / `leverage: 1` sit comfortably under the 100-notional default
 * limit, leaving headroom for a stricter-limit test.
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: DEFAULT_STUB_CONFIG.id,
  thresholdPercent: DEFAULT_STUB_CONFIG.negativeFundingThresholdPercent,
  direction: 'negative',
  entryOffsetSeconds: DEFAULT_STUB_CONFIG.entryOffsetSeconds,
  holdMs: DEFAULT_STUB_CONFIG.holdMs,
  entryQty: DEFAULT_STUB_CONFIG.entryQty,
  amountUsd: 50,
  leverage: 1,
}

export interface BuildOpts {
  readonly walPath: string
  /** When set, the unified trace writer is attached (header + events + transitions into one file). */
  readonly tracePath?: string
  readonly startMs?: number
  readonly clock?: VirtualClock
  readonly bus?: EventBus
  /** Engine-facing venue; the replay engine injects an inert (order-suppressing) sim. Defaults to a fresh sim. */
  readonly exchange?: SimExchange
  readonly repo?: Repo
  /** Timer source; the replay engine injects an inert one so recorded `Timer`s are the sole timer input. */
  readonly scheduler?: Scheduler
  readonly registry?: StrategyRegistry
  readonly strategyConfig?: RuntimeStrategyConfig
  readonly riskGate?: RiskGate
  readonly killSwitch?: KillSwitch
  readonly initialBalance?: Balance
  readonly accountSetupComplete?: boolean | ((symbol: string) => boolean)
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
  readonly killSwitch: KillSwitch
  readonly trace?: TraceFile
  readonly logger: Logger
}

export function buildSkeletonEngine(opts: BuildOpts): SkeletonHarness {
  const clock = opts.clock ?? createVirtualClock(opts.startMs ?? 0)
  const bus = opts.bus ?? createEventBus()
  const exchange = opts.exchange ?? createSimExchange(clock, bus)
  const rawWal = createWalFile({ path: opts.walPath })
  const repo = opts.repo ?? createInMemoryRepo()
  const registry = opts.registry ?? createStrategyRegistry([createStubStrategy(DEFAULT_STUB_CONFIG)])
  const strategyConfig = opts.strategyConfig ?? DEFAULT_RUNTIME_CONFIG
  const logger = opts.logger ?? createLogger({ instance: 'skeleton' })
  const scheduler = opts.scheduler ?? createScheduler(clock, bus)

  // Preflight deps. Balance seeded in the harness (not `engine.ts`) so the engine
  // stays fail-loud with no hidden default; real `main.ts` fetches the live balance.
  const initialBalance: Balance = opts.initialBalance ?? { asset: 'USDT', free: 10_000, used: 0 }
  const riskGate = opts.riskGate ?? createRiskGate({ maxConcurrentIntents: 10, maxNotionalUsd: 100 })
  const killSwitch = opts.killSwitch ?? createKillSwitch({ initial: 'off', clock, wal: rawWal })

  // Unified trace: header first, then tap the bus for `event` records and wrap
  // `wal.append` for `transition` records — one shared `seq` capturing their true
  // interleaving. The header snapshots the interim `RuntimeStrategyConfig` (no full
  // `EffectiveConfig` until `main.ts`; see `docs/trace-format.md` config-header gap).
  const trace = opts.tracePath === undefined ? undefined : createTraceFile({ path: opts.tracePath })
  if (trace) {
    trace.recordHeader({
      ts: clock.now(),
      configHash: computeConfigRevisionHash(strategyConfig),
      strategyConfig,
    })
    bus.subscribe((event) => trace.recordEvent(event, clock.now()))
  }
  const wal: TransitionLog = trace
    ? {
        append(entry: TransitionLogEntry): Promise<void> {
          trace.recordTransition(entry)
          return rawWal.append(entry)
        },
      }
    : rawWal

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
    riskGate,
    killSwitch,
    initialBalance,
    accountSetupComplete: opts.accountSetupComplete,
    onReconciliation,
  })

  return {
    clock,
    bus,
    exchange,
    wal: rawWal,
    repo,
    scheduler,
    engine,
    registry,
    strategyConfig,
    killSwitch,
    trace,
    logger,
  }
}
