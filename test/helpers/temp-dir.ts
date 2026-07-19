/**
 * Disposable temp directory for tests that need a real on-disk WAL / trace file
 * (task 0180 cleanup). Every crash/golden/persistence test hand-rolled the same
 * `mkdtempSync` → `join(dir, 'instance.wal.jsonl')` → `rmSync` dance; this is the
 * one definition. `walPath` is the conventional per-instance WAL path; `path()`
 * builds any other file inside the same dir (golden trace files, corrupted copies).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempDir {
  /** Absolute path of the temp directory. */
  readonly dir: string
  /** Conventional per-instance WAL path (`<dir>/instance.wal.jsonl`). */
  readonly walPath: string
  /** Build a path to `name` inside the temp dir. */
  path(name: string): string
  /** Remove the temp dir recursively. */
  dispose(): void
}

export function tempDir(prefix = 'test-'): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    walPath: join(dir, 'instance.wal.jsonl'),
    path: (name) => join(dir, name),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
