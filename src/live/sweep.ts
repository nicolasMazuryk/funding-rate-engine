/**
 * The venue-native **cancel sweep** contract (task 0470 phase 3).
 *
 * Teardown cannot use `adapter.cancelOrder(clientOrderId)`: the order manager resolves a
 * client id to its venue symbol from an **in-process, submit-time map**, and swallows
 * `NotFound`. An order left resting by an *earlier* run is therefore silently skipped —
 * exactly the leftover teardown exists to remove. So each venue implements a sweep off its
 * raw client, reading open orders account-wide and cancelling by the **venue's own order id**,
 * which needs no map to decode.
 *
 * One sweep per venue lives in `src/live/<venue>/cancel-sweep.ts`; they share this contract
 * and {@link cancelEach}.
 */

/** Cancel every resting order on the sub-account. Resolves to a label per cancelled order. */
export type CancelSweep = () => Promise<readonly string[]>

/**
 * Cancel every row, **never short-circuiting** — one venue reject must not strand the orders
 * behind it, because each stranded order is real money resting on a real book. Failures are
 * collected and thrown as one aggregate at the end (teardown records it and flattens anyway);
 * the message names both what was cancelled and what was not.
 */
export async function cancelEach<T>(
  rows: readonly T[],
  label: (row: T) => string,
  cancelOne: (row: T) => Promise<unknown>,
): Promise<readonly string[]> {
  const cancelled: string[] = []
  const failures: string[] = []
  for (const row of rows) {
    try {
      await cancelOne(row)
      cancelled.push(label(row))
    } catch (e) {
      failures.push(`${label(row)}: ${(e as Error).message}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `cancel sweep: ${failures.length} of ${rows.length} orders could not be cancelled ` +
        `[${failures.join('; ')}]; cancelled [${cancelled.join(', ')}]`,
    )
  }
  return cancelled
}
