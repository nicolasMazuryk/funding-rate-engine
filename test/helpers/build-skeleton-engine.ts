/**
 * Thin re-export: the skeleton composition root moved to `src/replay/
 * build-skeleton-harness.ts` in task 0170 (so non-test callers — `scripts/
 * replay.ts`, the replay engine — can reuse it without importing test code).
 * Existing test imports (`build-skeleton-engine.js`) keep working via this file.
 */

export * from '../../src/replay/build-skeleton-harness.js'
