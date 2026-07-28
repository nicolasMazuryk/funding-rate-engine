/**
 * Sub-account **preflight** for the live tier (task 0470 phase 3).
 *
 * The first thing a live run does is prove it is pointed at the right account. Every
 * violation below means "these keys are not the tiny, empty, dedicated sub-account this
 * harness is allowed to trade" — most dangerously, keys for a funded main account.
 *
 * Four probes, all of which run even when an earlier one fails: the report **aggregates**
 * violations rather than short-circuiting, so one run tells the operator everything that is
 * wrong instead of one thing per attempt. A probe that throws is itself a violation
 * (`probe_failed`) — an unreadable account is not a safe account — and an auth-shaped throw
 * is rewritten to name the IP-allowlist hypothesis, which is the overwhelmingly likely cause
 * here (the sub-account keys pin a single IP).
 *
 * Caller contract: a failed preflight **skips the rest of the suite without placing an
 * order** (`src/live/<venue>/registry.ts`).
 */

import type { ExchangeAdapter, Order, Position } from '../core/ports/exchange-adapter.js'

/** Why preflight refused the account. */
export type PreflightViolationKind =
  | 'balance_over_allocation'
  | 'open_positions'
  | 'open_orders'
  | 'position_mode'
  | 'probe_failed'

/** One reason this sub-account is not safe to trade. */
export interface PreflightViolation {
  readonly kind: PreflightViolationKind
  readonly detail: string
}

export interface PreflightReport {
  /** True only when every probe ran and found nothing. */
  readonly ok: boolean
  readonly violations: readonly PreflightViolation[]
  /** `free + used` quote balance; absent when the balance read failed. */
  readonly balanceUsdt?: number
  readonly allocatedCapitalUsdt: number
  /** The ceiling `balanceUsdt` was checked against. */
  readonly maxBalanceUsdt: number
}

export interface PreflightDeps {
  readonly exchange: Pick<ExchangeAdapter, 'getBalance' | 'getPositions' | 'getOpenOrders' | 'setPositionMode'>
  /** The sub-account's registry allocation, USDT (`config/subaccounts.yaml`). */
  readonly allocatedCapitalUsdt: number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * How far over its registry allocation a sub-account's balance may sit before preflight calls
 * it the wrong account. Slack, not licence: a live sub-account drifts above its allocation
 * through P&L and top-ups, but a **main** account is orders of magnitude over, not 2×.
 */
export const PREFLIGHT_BALANCE_MULTIPLE = 2

/** Auth-shaped venue errors — nearly always the pinned-IP allowlist rather than a bad key. */
const AUTH_PATTERN = /auth|signature|api[-_ ]?key|passphrase|permission|unauthor|forbidden|invalid.*(key|sign)/i

const IP_HYPOTHESIS =
  'the venue rejected these credentials — the sub-account keys are IP-allowlisted to one address, ' +
  'so the first thing to check is whether this machine is on that allowlist (then key validity, then permissions)'

/** Describe a probe throw, naming the IP-allowlist hypothesis when the error looks like auth. */
function describeFailure(probe: string, e: unknown): string {
  const err = e as { message?: string; kind?: string }
  const message = err?.message ?? String(e)
  const authShaped = err?.kind === 'AuthError' || AUTH_PATTERN.test(message)
  return authShaped ? `${probe} failed: ${message} — ${IP_HYPOTHESIS}` : `${probe} failed: ${message}`
}

/**
 * Run one probe. A throw becomes a `probe_failed` violation rather than aborting the report,
 * so the remaining probes still contribute their findings.
 */
async function probe<T>(name: string, violations: PreflightViolation[], run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (e) {
    violations.push({ kind: 'probe_failed', detail: describeFailure(name, e) })
    return undefined
  }
}

/**
 * Verify the account behind these credentials is the small, flat, one-way sub-account the live
 * tier is allowed to trade. Never throws on venue behaviour — everything lands in the report.
 */
export async function subAccountPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const { exchange, allocatedCapitalUsdt, log } = deps
  if (!Number.isFinite(allocatedCapitalUsdt) || allocatedCapitalUsdt <= 0) {
    // Config, not venue state: a missing allocation would disarm the balance ceiling entirely.
    throw new Error(`[live] preflight: allocatedCapitalUsdt must be a finite number > 0, got ${allocatedCapitalUsdt}`)
  }

  const violations: PreflightViolation[] = []
  const maxBalanceUsdt = allocatedCapitalUsdt * PREFLIGHT_BALANCE_MULTIPLE

  const balance = await probe('balance read', violations, () => exchange.getBalance())
  const balanceUsdt = balance === undefined ? undefined : balance.free + balance.used
  if (balanceUsdt !== undefined && balanceUsdt > maxBalanceUsdt) {
    violations.push({
      kind: 'balance_over_allocation',
      detail:
        `sub-account holds ${balanceUsdt.toFixed(2)} ${balance?.asset ?? 'USDT'}, over the ` +
        `${maxBalanceUsdt.toFixed(2)} ceiling (${PREFLIGHT_BALANCE_MULTIPLE}× the ${allocatedCapitalUsdt} allocation) — ` +
        'these look like the wrong keys',
    })
  }

  const positions = await probe<readonly Position[]>('position read', violations, () => exchange.getPositions())
  const open = (positions ?? []).filter((p) => p.qty > 0)
  if (open.length > 0) {
    violations.push({
      kind: 'open_positions',
      detail: `sub-account is not flat: ${open.map((p) => `${p.symbol} ${p.side} ${p.qty}`).join(', ')}`,
    })
  }

  const orders = await probe<readonly Order[]>('open-order read', violations, () => exchange.getOpenOrders())
  if ((orders ?? []).length > 0) {
    const named = (orders ?? []).map((o) => `${o.symbol} ${o.side} (${o.clientOrderId})`).join(', ')
    violations.push({ kind: 'open_orders', detail: `sub-account has resting orders: ${named}` })
  }

  // One-way mode is applied, not read: the port exposes no getter, and `setPositionMode` is the
  // idempotent set-in-advance call (`11` §1) every venue rejects when the account is in hedge
  // mode with positions open. Applying it is also what the suite needs to be true anyway.
  await probe('one-way position mode', violations, async () => {
    try {
      await exchange.setPositionMode('one_way')
    } catch (e) {
      violations.push({ kind: 'position_mode', detail: `cannot set one-way position mode: ${(e as Error).message}` })
    }
  })

  const report: PreflightReport = {
    ok: violations.length === 0,
    violations,
    ...(balanceUsdt === undefined ? {} : { balanceUsdt }),
    allocatedCapitalUsdt,
    maxBalanceUsdt,
  }
  if (!report.ok) log?.('live preflight refused the sub-account', { violations })
  return report
}
