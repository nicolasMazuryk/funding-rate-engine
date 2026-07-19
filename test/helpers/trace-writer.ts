/**
 * JSONL trace writer for the events log (task 0090). One deterministic line per
 * recorded value via {@link stableStringify} + `appendFileSync`, mirroring the
 * WAL's synchronous-durable append so the whole scenario's trace is on disk by
 * the time the driving clock advance returns — no async drain before compare.
 *
 * This is one of the two byte-compared golden streams (the other is the WAL);
 * pino handles human-facing operational logging separately (decision #3).
 */

import { appendFileSync, closeSync, openSync } from 'node:fs'
import { stableStringify } from './stable-stringify.js'

export interface TraceWriter {
  /** Append one record as a stable-stringified JSONL line. */
  record(entry: unknown): void
  /** Release the open file descriptor. */
  close(): void
}

export function createTraceWriter({ path }: { readonly path: string }): TraceWriter {
  const fd = openSync(path, 'a')
  return {
    record(entry: unknown): void {
      appendFileSync(fd, `${stableStringify(entry)}\n`)
    },
    close(): void {
      closeSync(fd)
    },
  }
}
