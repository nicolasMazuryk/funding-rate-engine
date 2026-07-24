/**
 * Composition root (task 0280; `09_configuration.md` §5 fail-loud startup) — the
 * one place the concrete ports are constructed and handed to the pure engine.
 * Everything upstream is pure or injectable; this file is the impure edge.
 *
 * Startup order (`09` §5): load + validate config (throws abort the process before
 * any order) → build the adapter → validate instruments via `adapter.init()` (`10`
 * §4, the final config step) → fetch the live balance → wire the engine → start the
 * scheduler. A `SIGTERM` tears down cleanly: stop scheduling, dispose the engine,
 * close the venue + WAL, end the DB pool.
 *
 * Adapter selection is by env: `ADAPTER=sim` (dev only) swaps in the credential-free
 * sim venue while still loading the `binance` YAML — the smoke path (`node src/main.ts`
 * boots and exits cleanly on SIGTERM with no venue creds). Default is `binance`.
 */

import { resolve } from 'node:path'
import { Pool } from 'pg'
import { createPnlSidecar } from './accounting/pnl-sidecar.js'
import { createReconciler } from './accounting/reconcile.js'
import { createRealClock } from './adapters/clock/real-clock.js'
import { createBinanceAdapter } from './adapters/exchanges/binance/adapter.js'
import { createBinanceClients, createBinanceRateLimiter } from './adapters/exchanges/binance/factory.js'
import type { ConsecutiveFailureCounter } from './adapters/shared/errors.js'
import { createSimExchange } from './adapters/sim/sim-exchange.js'
import {
  runtimeConfigFromEffective,
  type S1EngineDeps,
  wireS1Engine,
  wireS1WsEngine,
  wireS2Engine,
  wireS3aEngine,
  wireS4_1aEngine,
  wireS4_2aEngine,
  wireS6Engine,
} from './composition.js'
import type { EffectiveConfig } from './config/effective-config.js'
import { createInstrumentValidationHook } from './config/instrument-validation.js'
import { loadEffectiveConfig } from './config/load.js'
import { createEventBus } from './core/events/bus.js'
import type { Clock } from './core/ports/clock.js'
import type { ExchangeAdapter, TimeRange } from './core/ports/exchange-adapter.js'
import type { OpsEvent } from './core/runtime/engine.js'
import { createScheduler } from './core/runtime/scheduler.js'
import type { Instance } from './persistence/db/instance.js'
import { createPgRepo } from './persistence/db/repo.js'
import { createPersistenceProjector } from './persistence/projector.js'
import { recoverOnBoot } from './persistence/recovery.js'
import { createForwarder } from './persistence/wal/forwarder.js'
import { createWalFile } from './persistence/wal/wal-file.js'
import { createLogger } from './replay/logger.js'
import { type CircuitBreaker, createCircuitBreaker } from './risk/breaker.js'
import { createBreakerEscalation } from './risk/breaker-escalation.js'
import { flattenAll } from './risk/flatten.js'
import { createRiskGate } from './risk/gate.js'
import { createKillSwitch } from './risk/kill-switch.js'
import { wireOrderBreakerFeed } from './risk/order-breaker-feed.js'
import { createOrphanHandler } from './risk/orphan-handler.js'

/** Reduce-only close retry schedule reused by flatten + the orphan handler (S6's `07` §2 step 2 schedule). */
const CLOSE_BACKOFFS_MS: readonly number[] = [250, 1000, 3000]

/**
 * Build the venue adapter for `cfg` — the sim venue when `ADAPTER=sim`, else the Binance adapter.
 * The venue-io breaker is threaded in as the adapter's `failures` observer so every general-lane
 * REST call feeds it (`callGeneral` records success/failure).
 */
function buildAdapter(
  cfg: EffectiveConfig,
  clock: Clock,
  bus: ReturnType<typeof createEventBus>,
  failures: ConsecutiveFailureCounter,
  logger: ReturnType<typeof createLogger>,
): ExchangeAdapter {
  if (process.env.ADAPTER === 'sim') return createSimExchange(clock, bus)
  const clients = createBinanceClients(cfg.exchangeProfile, cfg.secrets)
  const limiter = createBinanceRateLimiter(cfg.exchangeProfile, clock)
  return createBinanceAdapter({
    client: clients.ccxt,
    clock,
    limiter,
    deny: cfg.symbols.deny,
    failures,
    log: (m, meta) => logger.warn(meta ?? {}, m),
  })
}

/** The two circuit breakers + their timing bounds, read from the validated `config.risk` (`13` §3, 0380). */
function buildBreakers(
  risk: Readonly<Record<string, number>>,
  clock: Clock,
): { ioBreaker: CircuitBreaker; orderBreaker: CircuitBreaker; escalationMs: number } {
  const cooldownMs = riskField(risk, 'breaker_cooldown_seconds') * 1000
  const escalationMs = riskField(risk, 'breaker_escalation_seconds') * 1000
  const ioBreaker = createCircuitBreaker({ clock, threshold: riskField(risk, 'breaker_error_threshold'), cooldownMs })
  const orderBreaker = createCircuitBreaker({
    clock,
    threshold: riskField(risk, 'breaker_order_reject_threshold'),
    cooldownMs,
    counts: (err) => err.kind === 'OrderRejected',
  })
  return { ioBreaker, orderBreaker, escalationMs }
}

/** Read a required numeric `config.risk` field (snake_case) or fail loud (`09` §5 validated it). */
function riskField(risk: Readonly<Record<string, number>>, key: string): number {
  const value = risk[key]
  if (typeof value !== 'number') throw new Error(`main: risk field '${key}' is missing`)
  return value
}

/** Risk limits from the validated `config.risk` (snake_case, `13` §1). */
function riskLimits(risk: Readonly<Record<string, number>>): { maxConcurrentIntents: number; maxNotionalUsd: number } {
  return {
    maxConcurrentIntents: riskField(risk, 'max_concurrent_intents'),
    maxNotionalUsd: riskField(risk, 'max_notional_usd'),
  }
}

async function run(): Promise<void> {
  // 1. Config — a throw here aborts before any port is built (`09` §5).
  const cfg = loadEffectiveConfig()
  const logger = createLogger({ instance: `${cfg.strategy}-${cfg.exchange}-${cfg.subaccount}` })
  logger.info({ revisionHash: cfg.revisionHash, adapter: process.env.ADAPTER ?? cfg.exchange }, 'starting instance')

  const clock = createRealClock()
  const bus = createEventBus()
  // Circuit breakers (`13` §3, 0380): the venue-io breaker doubles as the adapter's `failures`
  // observer; the order breaker is fed from the bus after the engine builds.
  const { ioBreaker, orderBreaker, escalationMs } = buildBreakers(cfg.risk, clock)
  const adapter = buildAdapter(cfg, clock, bus, ioBreaker, logger)

  // 2. Instrument validation = the adapter's fail-loud `init()` (`10` §4, `09` §5 step 6).
  await createInstrumentValidationHook(adapter).validate(cfg)

  // 3. Live balance for the preflight margin check (no hidden default — fail-loud).
  const initialBalance = await adapter.getBalance()

  // 4. Persistence ports: local WAL (hot path) + Postgres current-state projection.
  const walPath = process.env.WAL_PATH ?? resolve(process.cwd(), `${cfg.strategy}-${cfg.exchange}.wal.jsonl`)
  const wal = createWalFile({ path: walPath })
  const pool = new Pool({ connectionString: cfg.databaseUrl })
  const instance: Instance = { exchange: cfg.exchange, strategy: cfg.strategy, subaccount: cfg.subaccount }
  const repo = createPgRepo({ pool, instance })

  // 5. Risk + kill switch, then the engine, wired with the S1 module + timed handler.
  const riskGate = createRiskGate(riskLimits(cfg.risk))
  const killSwitch = createKillSwitch({ initial: cfg.killSwitch, clock, wal })
  const scheduler = createScheduler(clock, bus)
  // Select the strategy wiring by `cfg.strategy` (Registry pattern at the composition edge):
  // `s1` → the `timed` exit; `s1-ws` → the `funding_fee_event` gate; `s2` → the trailing
  // retracement gate. The WS-mandatory guard already ran in `load.ts` (`checkWsMandatoryGuard`),
  // so the WS-gated strategies only reach here validly.
  // Post-trade accounting (`15` §1, 0390): the sidecar books one `pnl` row per intent close
  // from the engine's realized-fact hook + the settled `funding_events` amount, off the hot path.
  const fees = { takerFeePct: cfg.exchangeProfile.takerFeePct, makerFeePct: cfg.exchangeProfile.makerFeePct }
  const pnlSidecar = createPnlSidecar({ repo, fees })
  // Reconciliation sidecar (`15` §2, 0400): per-close + periodic engine↔venue drift check; corrects
  // money (fees/funding) venue-wins, routes position desync to the orphan handler. Reuses the ops
  // channel for its beyond-tolerance alert. Fires alongside the pnl-sidecar on the same close.
  const onOpsEvent = (event: OpsEvent): void => logger.warn({ ops: event }, event.kind)
  const reconciler = createReconciler({
    repo,
    exchange: adapter,
    bus,
    clock,
    tolerances: {
      fillPricePercent: riskField(cfg.risk, 'reconcile_fill_price_tolerance_percent'),
      feeUsd: riskField(cfg.risk, 'reconcile_fee_tolerance_usd'),
      fundingUsd: riskField(cfg.risk, 'reconcile_funding_tolerance_usd'),
      qty: riskField(cfg.risk, 'reconcile_qty_tolerance'),
    },
    sweepSeconds: riskField(cfg.risk, 'reconcile_sweep_seconds'),
    fees,
    now: clock.now,
    onOpsEvent,
  })
  const engineDeps: S1EngineDeps = {
    bus,
    clock,
    scheduler,
    exchange: adapter,
    wal,
    repo,
    strategyConfig: runtimeConfigFromEffective(cfg),
    riskGate,
    killSwitch,
    breakerOpen: () => ioBreaker.isOpen(), // sole preflight consultation for the venue-io breaker
    initialBalance,
    configHash: cfg.revisionHash,
    onOpsEvent,
    // Both accounting sidecars fire on the same terminal close: the pnl-sidecar books the baseline row,
    // the reconciler corrects it venue-wins (`15` §1/§2). Order-independent (0400 doc).
    onTradeClose: (ctx) => {
      pnlSidecar.onTradeClose(ctx)
      reconciler.onTradeClose(ctx)
    },
  }
  const gateDeps = { clock, fundingIncome: (symbol: string, range: TimeRange) => adapter.fundingIncome(symbol, range) }
  const engine =
    cfg.strategy === 's2'
      ? wireS2Engine(engineDeps, gateDeps)
      : cfg.strategy === 's3a'
        ? wireS3aEngine(engineDeps)
        : cfg.strategy === 's4-1a'
          ? wireS4_1aEngine(engineDeps)
          : cfg.strategy === 's4-2a'
            ? wireS4_2aEngine(engineDeps)
            : cfg.strategy === 's6'
              ? wireS6Engine(engineDeps, gateDeps)
              : cfg.strategy === 's1-ws'
                ? wireS1WsEngine(engineDeps, gateDeps)
                : wireS1Engine(engineDeps)

  // Risk layer (`13` §3/§4, 0380): the order-breaker bus feed + live-intent → paused escalation,
  // orphan auto-flatten, breaker-open → flatten escalation, and the kill-switch `flatten` → venue
  // ground-truth flattenAll. Escalation/flatten go through `killSwitch.transition`, which already
  // WAL-logs + write-throughs (0370) — no new persistence here.
  const orphanHandler = createOrphanHandler({
    bus,
    clock,
    exchange: adapter,
    backoffsMs: CLOSE_BACKOFFS_MS,
    log: (m, meta) => logger.warn(meta ?? {}, m),
  })
  const unwireOrderBreaker = wireOrderBreakerFeed({
    bus,
    breaker: orderBreaker,
    killSwitch,
    hasLiveIntent: () => engine.liveIntentCount() > 0,
  })
  const breakerEscalation = createBreakerEscalation({
    breakers: [ioBreaker, orderBreaker],
    killSwitch,
    clock,
    escalationMs,
  })
  const unsubFlatten = killSwitch.subscribe((state) => {
    if (state === 'flatten') {
      void flattenAll({
        exchange: adapter,
        clock,
        bus,
        backoffsMs: CLOSE_BACKOFFS_MS,
        log: (m, meta) => logger.warn(meta ?? {}, m),
      })
    }
  })

  // Derived-fact persistence: mirror bus facts (orders/fills/positions/funding) into
  // Postgres off the hot path (`14` §3, 0360); persist each kill-switch flip too.
  const projector = createPersistenceProjector({ bus, repo, now: clock.now })
  const unsubKillSwitch = killSwitch.subscribe(
    (state) => void repo.upsertKillSwitch?.({ state, updatedTs: clock.now() }).catch(() => {}),
  )

  // WAL → Postgres shipping, off the hot path (`14` §2.1). Pre-0370 gap: this never ran in
  // the live composition root (only the e2e harness started it).
  const forwarder = createForwarder({ wal, pool, instance })
  forwarder.start()

  // Full crash recovery (`14` §5, task 0370): config-hash fail-loud check, replay the WAL
  // (local + shipped Postgres history), reconstruct every non-terminal intent, reconcile vs
  // venue REST, restore the kill switch — all BEFORE the scheduler starts driving the engine.
  await recoverOnBoot({ repo, wal, engine, killSwitch, configHash: cfg.revisionHash, instance, pool })

  scheduler.start()
  reconciler.start() // arm the periodic engine↔venue position sweep (`15` §2, 0400)
  logger.info('instance running')

  // Clean SIGTERM: stop scheduling, dispose the engine, close the venue + WAL, end the pool.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')
    scheduler.stop()
    reconciler.stop()
    forwarder.stop()
    unsubKillSwitch()
    // Risk-layer teardown (0380): drop bus subscriptions + cancel breaker/escalation timers.
    orphanHandler.dispose()
    unwireOrderBreaker()
    breakerEscalation.dispose()
    unsubFlatten()
    ioBreaker.dispose()
    orderBreaker.dispose()
    projector.stop()
    engine.dispose()
    await adapter.close().catch(() => {})
    wal.close()
    await pool.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

run().catch((err) => {
  // Fail-loud: any startup error aborts with a non-zero code (`09` §5).
  console.error('fatal: instance failed to start', err)
  process.exit(1)
})
