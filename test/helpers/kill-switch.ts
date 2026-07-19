/**
 * A kill switch fixed at `paused` with a throwaway WAL (task 0180 cleanup), so a
 * harness's own WAL holds only engine transitions. Shared by the engine-unit and
 * skeleton-e2e preflight-reject tests.
 */

import { createKillSwitch, type KillSwitch } from '../../src/risk/kill-switch.js'

export function pausedKillSwitch(): KillSwitch {
  return createKillSwitch({
    initial: 'paused',
    clock: { now: () => 0, scheduleTimer: () => ({ cancel() {} }) },
    wal: { append: () => Promise.resolve() },
  })
}
