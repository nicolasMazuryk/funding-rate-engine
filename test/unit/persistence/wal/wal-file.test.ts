import { closeSync, ftruncateSync, openSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { intentMachine, transitionIntent } from '../../../../src/core/intent/intent-machine.js'
import type { TransitionLogEntry } from '../../../../src/core/ports/transition-log.js'
import { createWalFile, type WalFile } from '../../../../src/persistence/wal/wal-file.js'
import { type TempDir, tempDir } from '../../../helpers/temp-dir.js'

let tmp: TempDir
let walPath: string

beforeEach(() => {
  tmp = tempDir('wal-file-test-')
  walPath = tmp.walPath
})

function entry(i: number): TransitionLogEntry {
  return { ts: 1_000 + i, intentId: `intent-${i}`, fromState: 'SELECTED', toState: 'SUBMITTING_ENTRY', payload: {} }
}

describe('createWalFile', () => {
  it('append then readAll returns records in order with contiguous seq', async () => {
    const wal = createWalFile({ path: walPath })
    for (let i = 0; i < 5; i++) {
      await wal.append(entry(i))
    }
    wal.close()

    const records = createWalFile({ path: walPath }).readAll()
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4])
    expect(records.map((r) => r.intentId)).toEqual(['intent-0', 'intent-1', 'intent-2', 'intent-3', 'intent-4'])
  })

  it('a written record round-trips deep-equal', async () => {
    const wal = createWalFile({ path: walPath })
    const record: TransitionLogEntry = {
      ts: 42,
      intentId: 'intent-x',
      fromState: 'MONITORING',
      toState: 'EXITING',
      payload: { note: 'nested', n: 1 },
      clientOrderId: 'co-1',
    }
    await wal.append(record)
    wal.close()

    const [readBack] = createWalFile({ path: walPath }).readAll()
    expect(readBack).toEqual({ ...record, seq: 0 })
  })

  it('resumes seq from an existing file across reopen', async () => {
    const first = createWalFile({ path: walPath })
    await first.append(entry(0))
    await first.append(entry(1))
    first.close()

    const second = createWalFile({ path: walPath })
    await second.append(entry(2))
    second.close()

    const records = createWalFile({ path: walPath }).readAll()
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2])
  })

  it('a torn final line is discarded with a warning, not thrown', async () => {
    const wal = createWalFile({ path: walPath })
    await wal.append(entry(0))
    await wal.append(entry(1))
    wal.close()

    // Simulate a crash mid-write: cut the tail off the last record only, leaving
    // the first record's line fully intact.
    const firstLine = readFileSync(walPath, 'utf8').split('\n').at(0) ?? ''
    const tornLength = firstLine.length + 1 + 10
    const fd = openSync(walPath, 'r+')
    ftruncateSync(fd, tornLength)
    closeSync(fd)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const records = createWalFile({ path: walPath }).readAll()
    expect(records.map((r) => r.seq)).toEqual([0])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reading a nonexistent file returns an empty array', () => {
    expect(createWalFile({ path: tmp.path('missing.wal.jsonl') }).readAll()).toEqual([])
  })
})

describe('WAL wired to the intent machine onTransition observer', () => {
  let wal: WalFile

  afterEach(() => {
    wal.close()
  })

  it('the WAL record exists before a later post-commit observer runs', () => {
    wal = createWalFile({ path: walPath })
    const order: string[] = []

    const unsubscribeWal = intentMachine.onTransition(({ from, to, payload }) => {
      // Fire-and-forget: `append` has no internal `await`, so the fsync'd
      // write is already on disk by the time this observer returns — even
      // though the caller never awaits the returned promise (`14` §2.1).
      void wal.append({ ts: 0, intentId: 'intent-wired', fromState: from, toState: to, payload })
      order.push('wal')
    })
    const unsubscribePostCommit = intentMachine.onTransition(() => {
      // Runs after the WAL observer (registration order) — the "post-commit callback".
      expect(wal.readAll()).toHaveLength(1)
      order.push('post-commit')
    })

    transitionIntent('SELECTED', 'SUBMITTING_ENTRY', {})

    expect(order).toEqual(['wal', 'post-commit'])
    expect(wal.readAll()[0]).toMatchObject({ fromState: 'SELECTED', toState: 'SUBMITTING_ENTRY' })

    unsubscribeWal()
    unsubscribePostCommit()
  })
})
