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
import { createFundingFeeEventHandler } from '../core/intent/exit-policies/funding-fee-event.js'
import { createRetracementHandler } from '../core/intent/exit-policies/retracement.js'
import {
  createLadderSlTpDeadlineHandler,
  createSlTpDeadlineHandler,
} from '../core/intent/exit-policies/sl-tp-deadline.js'
import { TIMED_HANDLER } from '../core/intent/exit-policies/timed.js'
import { createExitPolicyRegistry, type ExitPolicyRegistry } from '../core/intent/exit-policy.js'
import type { EventBus } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { Balance, ExchangeAdapter, TimeRange } from '../core/ports/exchange-adapter.js'
import type { Repo } from '../core/ports/repo.js'
import type { RiskGate } from '../core/ports/risk-gate.js'
import type { TransitionLog, TransitionLogEntry } from '../core/ports/transition-log.js'
import { createEngine, type Engine, type OpsEvent, type ReconciliationRecord } from '../core/runtime/engine.js'
import { createScheduler, type Scheduler } from '../core/runtime/scheduler.js'
import {
  createStrategyRegistry,
  type RuntimeStrategyConfig,
  type StrategyRegistry,
} from '../core/strategies/registry.js'
import { createStrategy1 } from '../core/strategies/strategy-1.js'
import { createStrategy1Ws } from '../core/strategies/strategy-1-ws.js'
import { createStrategy2 } from '../core/strategies/strategy-2.js'
import { createStrategy3a, strategy3aGeometry } from '../core/strategies/strategy-3a.js'
import { createStrategy4_1a, strategy4_1aTpGeometry } from '../core/strategies/strategy-4-1a.js'
import { createStrategy4_2a } from '../core/strategies/strategy-4-2a.js'
import { createStrategy6, strategy6Geometry } from '../core/strategies/strategy-6.js'
import { createWalFile, type WalFile } from '../persistence/wal/wal-file.js'
import { createRiskGate } from '../risk/gate.js'
import { createKillSwitch, type KillSwitch } from '../risk/kill-switch.js'
import { createInMemoryRepo } from './in-memory-repo.js'
import { createLogger } from './logger.js'
import { createTraceFile, type TraceFile } from './trace-file.js'

/**
 * The engine-facing runtime config for the skeleton test suites, driving the real
 * S1 module + `timed` handler. Values are chosen for the shared scenario
 * (`test/helpers/skeleton-scenario.ts`), not production:
 * - `thresholdPercent -0.3` — BTC's scripted `-0.35` selects, ETH's `+0.01` does not.
 * - `entryOffsetSeconds 90` — entry timer at `T_settle − 90 s`.
 * - `exitOffsetSeconds 210` — `timed` deadline at `T_settle + 210 s`; with the scenario's
 *   `T_settle` at 08:00 this reproduces the old `entry(+90 s before) + 300 s hold` instant,
 *   keeping the deadline timeline stable across the skeleton→S1 switch.
 * - `amountUsd 60` / `leverage 1` — sizes BTC (price 60 000, lot 0.001) to qty `0.001`,
 *   stays under the 100-notional default risk limit, and needs 60 free margin.
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: 's1',
  thresholdPercent: -0.3,
  direction: 'negative',
  entryOffsetSeconds: 90,
  exitOffsetSeconds: 210,
  amountUsd: 60,
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
  /** Exit-policy dispatch table; defaults to the placeholder `timed` handler. Later strategy harnesses inject their own. */
  readonly exitPolicyRegistry?: ExitPolicyRegistry
  readonly strategyConfig?: RuntimeStrategyConfig
  readonly riskGate?: RiskGate
  readonly killSwitch?: KillSwitch
  readonly initialBalance?: Balance
  readonly accountSetupComplete?: boolean | ((symbol: string) => boolean)
  readonly onReconciliation?: (record: ReconciliationRecord) => void
  /** Diagnostic ops-event sink (S4.1a `ladder.pre_funding_fill`); defaults to writing an `ops` trace record. */
  readonly onOpsEvent?: (event: OpsEvent) => void
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
  readonly exitPolicyRegistry: ExitPolicyRegistry
  readonly strategyConfig: RuntimeStrategyConfig
  readonly killSwitch: KillSwitch
  readonly trace?: TraceFile
  readonly logger: Logger
}

/**
 * Default strategy + exit-policy registries for a `strategyConfig`, keyed by its id — the
 * harness analogue of `main.ts`'s wiring select. `s1-ws` gets the `funding_fee_event`
 * handler (its gate reads `exchange.fundingIncome`); everything else the S1 `timed` pair.
 * Centralized here so every harness caller — scenario/golden/e2e *and* the replay engine
 * (which reconstructs the core from a trace header) — resolves the right handler for free.
 */
function defaultRegistries(
  strategyConfig: RuntimeStrategyConfig,
  clock: Clock,
  exchange: ExchangeAdapter,
): { registry: StrategyRegistry; exitPolicyRegistry: ExitPolicyRegistry } {
  if (strategyConfig.id === 's1-ws') {
    const handler = createFundingFeeEventHandler({
      clock,
      fundingIncome: (symbol, range) => exchange.fundingIncome(symbol, range),
    })
    return {
      registry: createStrategyRegistry([createStrategy1Ws()]),
      exitPolicyRegistry: createExitPolicyRegistry([handler]),
    }
  }
  if (strategyConfig.id === 's2') {
    const handler = createRetracementHandler({
      clock,
      fundingIncome: (symbol, range) => exchange.fundingIncome(symbol, range),
    })
    return {
      registry: createStrategyRegistry([createStrategy2()]),
      exitPolicyRegistry: createExitPolicyRegistry([handler]),
    }
  }
  if (strategyConfig.id === 's3a') {
    // S3a's `sl_tp_deadline` handler owns no gate — static OCO legs + a deadline (`04` §3).
    return {
      registry: createStrategyRegistry([createStrategy3a()]),
      exitPolicyRegistry: createExitPolicyRegistry([createSlTpDeadlineHandler(strategy3aGeometry)]),
    }
  }
  if (strategyConfig.id === 's4-1a') {
    // S4.1a's ladder: `entryPlan` drives the N-rung engine path + engine-side SL; the handler owns
    // only the per-fill TP re-place (`05` §2/§3).
    return {
      registry: createStrategyRegistry([createStrategy4_1a()]),
      exitPolicyRegistry: createExitPolicyRegistry([createLadderSlTpDeadlineHandler(strategy4_1aTpGeometry)]),
    }
  }
  if (strategyConfig.id === 's4-2a') {
    // S4.2a's single limit: `entryPlan` drives the one-rung engine path + engine-side SL + the
    // `limit_expired` no-fill terminal; the handler owns only the per-fill TP (reused from S4.1a).
    return {
      registry: createStrategyRegistry([createStrategy4_2a()]),
      exitPolicyRegistry: createExitPolicyRegistry([createLadderSlTpDeadlineHandler(strategy4_1aTpGeometry)]),
    }
  }
  if (strategyConfig.id === 's6') {
    // S6's `entrySubMachine` marker drives the PRE_FUNDING → funding-gate → MAIN reversal entry; its
    // gate reads `exchange.fundingIncome`. The exit is the static OCO handler with S6's settled-`|F|`
    // geometry, registered under S6's own kind.
    const gate = { clock, fundingIncome: (symbol: string, range: TimeRange) => exchange.fundingIncome(symbol, range) }
    return {
      registry: createStrategyRegistry([createStrategy6(gate)]),
      exitPolicyRegistry: createExitPolicyRegistry([
        createSlTpDeadlineHandler(strategy6Geometry, 'sl_tp_deadline_post_funding_event'),
      ]),
    }
  }
  return {
    registry: createStrategyRegistry([createStrategy1()]),
    exitPolicyRegistry: createExitPolicyRegistry([TIMED_HANDLER]),
  }
}

export function buildSkeletonEngine(opts: BuildOpts): SkeletonHarness {
  const clock = opts.clock ?? createVirtualClock(opts.startMs ?? 0)
  const bus = opts.bus ?? createEventBus()
  const exchange = opts.exchange ?? createSimExchange(clock, bus)
  const rawWal = createWalFile({ path: opts.walPath })
  const repo = opts.repo ?? createInMemoryRepo()
  const strategyConfig = opts.strategyConfig ?? DEFAULT_RUNTIME_CONFIG
  // Explicit registry/exit-policy opts win; otherwise default by the strategy id.
  const defaults = defaultRegistries(strategyConfig, clock, exchange)
  const registry = opts.registry ?? defaults.registry
  const exitPolicyRegistry = opts.exitPolicyRegistry ?? defaults.exitPolicyRegistry
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

  // Default ops-event sink: write an `ops` trace record (diagnostic, never diffed) so a golden run
  // that hits `ladder.pre_funding_fill` carries it; absent a trace, drop it. Explicit opt wins.
  const onOpsEvent =
    opts.onOpsEvent ??
    (trace
      ? (event: OpsEvent) =>
          trace.recordOps({ ts: clock.now(), intentId: event.intentId, event: event.kind, symbol: event.symbol })
      : undefined)

  const engine = createEngine({
    bus,
    clock,
    scheduler,
    exchange,
    wal,
    repo,
    registry,
    exitPolicyRegistry,
    strategyConfig,
    riskGate,
    killSwitch,
    initialBalance,
    accountSetupComplete: opts.accountSetupComplete,
    onReconciliation,
    onOpsEvent,
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
    exitPolicyRegistry,
    strategyConfig,
    killSwitch,
    trace,
    logger,
  }
}
