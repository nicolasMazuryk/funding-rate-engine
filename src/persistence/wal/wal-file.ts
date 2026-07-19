/**
 * Local append-only WAL file (`14_persistence_and_recovery.md` §2, §2.1).
 *
 * Tier 1 of the two-tier write path: `append` fsync's a JSONL record before
 * resolving. It has no internal `await`, so by the time the synchronous call
 * stack returns to the caller — even a `void`-returning transition observer
 * that never awaits the returned promise — the record is already durable on
 * disk (`14` §2.1 step 1: "THIS gates the side effect"). `readAll` replays
 * the file in append order for recovery (`14` §5); a torn final line (crash
 * mid-write) is discarded with a warning, never thrown — any earlier corrupt
 * line is a hard failure (fail loud).
 *
 * Implements the `TransitionLog` port (`src/core/ports/transition-log.ts`);
 * the Postgres forwarder (tier 2) is task 0080.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs'
import type { TransitionLog, TransitionLogEntry } from '../../core/ports/transition-log.js'

/** A `TransitionLogEntry` as durably stored, tagged with its monotonic sequence number. */
export interface WalRecord extends TransitionLogEntry {
  readonly seq: number
}

export interface WalFile extends TransitionLog {
  /** Replay every durable record in append order (`14` §5). */
  readAll(): readonly WalRecord[]
  /** Release the open file descriptor. */
  close(): void
}

/** Open (or create) the WAL file at `path`; resumes `seq` from any records already there. */
export function createWalFile(options: { readonly path: string }): WalFile {
  const { path } = options
  const existing = readWalRecords(path)
  const last = existing.at(-1)
  let nextSeq = last === undefined ? 0 : last.seq + 1
  const fd = openSync(path, 'a')

  return {
    async append(entry: TransitionLogEntry) {
      const record: WalRecord = { ...entry, seq: nextSeq }
      nextSeq += 1
      appendFileSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    },
    readAll() {
      return readWalRecords(path)
    },
    close() {
      closeSync(fd)
    },
  }
}

/** Parse every complete JSONL record in `path`; a torn final line is discarded with a warning. */
function readWalRecords(path: string): WalRecord[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
  const records: WalRecord[] = []
  lines.forEach((line, i) => {
    try {
      records.push(JSON.parse(line) as WalRecord)
    } catch (err) {
      if (i !== lines.length - 1) {
        throw new Error(`[wal] corrupt record at line ${i + 1} of ${path}: ${(err as Error).message}`)
      }
      console.warn(`[wal] discarding torn final record in ${path}`)
    }
  })
  return records
}
