/**
 * Ports barrel — the interfaces the pure core depends on (`08_system_overview.md` §5).
 * Adapters, persistence, and risk implement these; the core imports only from here.
 */

export type { EventBus, EventHandler, Unsubscribe } from './bus.js'
export type { Clock, TimerHandle } from './clock.js'
export type {
  Balance,
  ExchangeAdapter,
  FundingEvent,
  Instrument,
  MarginMode,
  Market,
  MarketStatus,
  Order,
  OrderAck,
  OrderRequest,
  OrderStatus,
  OrderType,
  Position,
  PositionMode,
  PrivateStream,
  PublicStream,
  Rate,
  Side,
  TimeRange,
} from './exchange-adapter.js'
export type { IntentId, IntentSnapshot, IntentState, Repo } from './repo.js'
export type { RiskDecision, RiskGate, RiskIntent } from './risk-gate.js'
export type { TransitionLog, TransitionLogEntry } from './transition-log.js'
