/**
 * Serial check runner (task 0260). Tests share account state (position-mode /
 * margin-mode are account-wide, `11` §1), so checks run one at a time in the
 * registry's declared order, never in parallel. Each check gets a fresh cleanup
 * registry; cleanups run in `finally`, LIFO, and a cleanup failure never masks the
 * check's own result — it only ever gets a best-effort chance to cancel a resting
 * order or flatten a position.
 */

import type { Check, CheckContext, CheckResult, CheckStatus, TestnetSummary } from './types.js'

export interface RunChecksOptions {
  /** Injected so the runner never calls `Date.now()` directly (mirrors `Clock` elsewhere). */
  readonly now: () => number
}

/**
 * Run `checks` serially against `baseCtx`, aggregating one {@link TestnetSummary}.
 * `baseCtx` carries everything except `onCleanup` — the runner supplies a fresh one
 * per check so cleanups never leak across checks.
 */
export async function runChecks<Ctx extends CheckContext>(
  venue: string,
  toolVersion: string,
  checks: readonly Check<Ctx>[],
  baseCtx: Omit<Ctx, 'onCleanup'>,
  opts: RunChecksOptions,
): Promise<TestnetSummary> {
  const startedAtMs = opts.now()
  const results: CheckResult[] = []

  for (const check of checks) {
    const cleanups: Array<() => Promise<void>> = []
    const ctx = {
      ...baseCtx,
      onCleanup: (fn: () => Promise<void>) => {
        cleanups.push(fn)
      },
    } as Ctx

    const startMs = opts.now()
    let status: CheckStatus
    let reason: string | undefined
    let detail: unknown

    try {
      const outcome = await check.run(ctx)
      status = outcome.status
      reason = outcome.reason
      detail = outcome.detail
    } catch (err) {
      status = 'fail'
      reason = err instanceof Error ? err.message : String(err)
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup()
        } catch {
          // Best-effort: a cleanup failure must not mask the check's own verdict.
        }
      }
    }

    results.push({ name: check.name, specRef: check.specRef, status, reason, durationMs: opts.now() - startMs, detail })
  }

  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const skipped = results.filter((r) => r.status === 'skip').length

  return {
    venue,
    network: 'testnet',
    toolVersion,
    startedAtMs,
    durationMs: opts.now() - startedAtMs,
    total: results.length,
    passed,
    failed,
    skipped,
    results,
  }
}

/** Bound a promise to `ms`; rejects with a labeled timeout error instead of hanging forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Retry a known-slow testnet op `attempts` times, waiting `delayMs` between tries. */
export async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs = 1_000): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastErr
}
