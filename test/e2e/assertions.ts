/**
 * E2E assertion helpers (task 0270). Small, reusable checks over the persisted
 * state a full instance produces: the terminal `intents` row, the WAL↔DB
 * consistency between the local WAL and forwarded `intent_wal`, and the
 * `intents` current-state row shape (the available "trade record" until full
 * accounting lands in 0390).
 */

import { expect } from 'vitest'
import type { WalRecord } from '../../src/persistence/wal/wal-file.js'
import type { WalDbRow } from './harness.js'

/** Assert an intent reached the expected terminal state with its `exit_reason` / `error_code`. */
export function expectTerminal(
  row: Record<string, unknown> | undefined,
  expected: { readonly state: string; readonly exitReason?: string; readonly errorCode?: string },
): void {
  expect(row, 'intent row should exist').toBeDefined()
  expect(row?.state).toBe(expected.state)
  if (expected.exitReason !== undefined) expect(row?.exit_reason).toBe(expected.exitReason)
  if (expected.errorCode !== undefined) expect(row?.error_code).toBe(expected.errorCode)
}

/** The result of a WAL↔DB consistency check: which local transitions did / did not reach `intent_wal`. */
export interface WalConsistency {
  /** Every local-WAL transition for the intent is present in `intent_wal`. */
  readonly consistent: boolean
  /** Local transitions (`from→to`) in append order. */
  readonly local: string[]
  /** Forwarded transitions (`from→to`) in `seq` order. */
  readonly db: string[]
  /** Local transitions with no matching `intent_wal` row (the drift a missing forwarder leaves). */
  readonly missing: string[]
}

/**
 * Check that **every local-WAL transition for `intentId` is present in
 * `intent_wal`** (the WAL↔DB consistency property, `14` §2.1 / `17` §4). Returns a
 * report rather than throwing so a test can assert both consistency *and* that the
 * check detects drift (DoD #2: skipping the forwarder must be caught).
 */
export function checkWalDbConsistency(
  localWalRecords: readonly WalRecord[],
  dbWalRows: readonly WalDbRow[],
  intentId: string,
): WalConsistency {
  const local = localWalRecords.filter((r) => r.intentId === intentId).map((r) => `${r.fromState}->${r.toState}`)
  const db = dbWalRows.map((r) => `${r.from_state}->${r.to_state}`)
  // Multiset containment: consume one DB match per local transition.
  const remaining = [...db]
  const missing: string[] = []
  for (const t of local) {
    const idx = remaining.indexOf(t)
    if (idx === -1) missing.push(t)
    else remaining.splice(idx, 1)
  }
  return { consistent: missing.length === 0, local, db, missing }
}

/** The numeric `pnl` value columns, read from a raw `SELECT * FROM pnl` row (doubles come back as numbers). */
export interface PnlComponents {
  readonly delta_pnl: number
  readonly funding_pnl: number
  readonly fee_cost: number
  readonly net_pnl: number
}

/** Read the four value columns off a raw `pnl` row as numbers (Postgres `double precision` → number). */
function pnlComponents(row: Record<string, unknown>): PnlComponents {
  return {
    delta_pnl: Number(row.delta_pnl),
    funding_pnl: Number(row.funding_pnl),
    fee_cost: Number(row.fee_cost),
    net_pnl: Number(row.net_pnl),
  }
}

/**
 * Assert a `pnl` row exists for the intent, its `net_pnl` equals its stored components
 * (`delta_pnl + funding_pnl − fee_cost` — the recompute-from-components identity, quote
 * ccy), and any expected column values match. Returns the components for further checks.
 */
export function expectPnlRow(
  row: Record<string, unknown> | undefined,
  expected: {
    readonly exitReason?: string
    readonly errorCode?: string
    readonly fundingPnl?: number
    readonly netPnl?: number
    readonly fillCount?: number
  } = {},
): PnlComponents {
  expect(row, 'pnl row should exist').toBeDefined()
  const r = row as Record<string, unknown>
  const c = pnlComponents(r)
  expect(c.net_pnl).toBeCloseTo(c.delta_pnl + c.funding_pnl - c.fee_cost, 6)
  if (expected.exitReason !== undefined) expect(r.exit_reason).toBe(expected.exitReason)
  if (expected.errorCode !== undefined) expect(r.error_code).toBe(expected.errorCode)
  if (expected.fundingPnl !== undefined) expect(c.funding_pnl).toBeCloseTo(expected.fundingPnl, 6)
  if (expected.netPnl !== undefined) expect(c.net_pnl).toBeCloseTo(expected.netPnl, 6)
  if (expected.fillCount !== undefined) expect(Number(r.fill_count)).toBe(expected.fillCount)
  return c
}

/**
 * Assert the `intents` current-state row has the trade-record projection shape:
 * identity (`intent_id`, `symbol`), lifecycle (`state`), and the terminal
 * outcome columns (`exit_reason` / `error_code`). Full trade records are
 * accounting (0390); this row projection is the available "trade record" here.
 */
export function expectTradeRecordShape(row: Record<string, unknown> | undefined): void {
  expect(row, 'intent row should exist').toBeDefined()
  const r = row as Record<string, unknown>
  expect(r).toHaveProperty('intent_id')
  expect(r).toHaveProperty('symbol')
  expect(r).toHaveProperty('state')
  expect(r).toHaveProperty('exit_reason')
  expect(r).toHaveProperty('error_code')
}
