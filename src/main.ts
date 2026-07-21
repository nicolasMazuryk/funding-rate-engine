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
import { createRealClock } from './adapters/clock/real-clock.js'
import { createBinanceAdapter } from './adapters/exchanges/binance/adapter.js'
import { createBinanceClients, createBinanceRateLimiter } from './adapters/exchanges/binance/factory.js'
import { createSimExchange } from './adapters/sim/sim-exchange.js'
import {
  runtimeConfigFromEffective,
  type S1EngineDeps,
  wireS1Engine,
  wireS1WsEngine,
  wireS2Engine,
  wireS3aEngine,
} from './composition.js'
import type { EffectiveConfig } from './config/effective-config.js'
import { createInstrumentValidationHook } from './config/instrument-validation.js'
import { loadEffectiveConfig } from './config/load.js'
import { createEventBus } from './core/events/bus.js'
import type { Clock } from './core/ports/clock.js'
import type { ExchangeAdapter, TimeRange } from './core/ports/exchange-adapter.js'
import { createScheduler } from './core/runtime/scheduler.js'
import type { Instance } from './persistence/db/instance.js'
import { createPgRepo } from './persistence/db/repo.js'
import { createWalFile } from './persistence/wal/wal-file.js'
import { createLogger } from './replay/logger.js'
import { createRiskGate } from './risk/gate.js'
import { createKillSwitch } from './risk/kill-switch.js'

/** Build the venue adapter for `cfg` — the sim venue when `ADAPTER=sim`, else the Binance adapter. */
function buildAdapter(cfg: EffectiveConfig, clock: Clock, bus: ReturnType<typeof createEventBus>): ExchangeAdapter {
  if (process.env.ADAPTER === 'sim') return createSimExchange(clock, bus)
  const clients = createBinanceClients(cfg.exchangeProfile, cfg.secrets)
  const limiter = createBinanceRateLimiter(cfg.exchangeProfile, clock)
  return createBinanceAdapter({ client: clients.ccxt, clock, limiter, deny: cfg.symbols.deny })
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
  const adapter = buildAdapter(cfg, clock, bus)

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
    initialBalance,
    onReconciliation: (record) => logger.info({ reconciliation: record }, 'reconciliation'),
  }
  const gateDeps = { clock, fundingIncome: (symbol: string, range: TimeRange) => adapter.fundingIncome(symbol, range) }
  const engine =
    cfg.strategy === 's2'
      ? wireS2Engine(engineDeps, gateDeps)
      : cfg.strategy === 's3a'
        ? wireS3aEngine(engineDeps)
        : cfg.strategy === 's1-ws'
          ? wireS1WsEngine(engineDeps, gateDeps)
          : wireS1Engine(engineDeps)

  scheduler.start()
  logger.info('instance running')

  // Clean SIGTERM: stop scheduling, dispose the engine, close the venue + WAL, end the pool.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')
    scheduler.stop()
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
