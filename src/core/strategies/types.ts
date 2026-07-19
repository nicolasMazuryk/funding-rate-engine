/**
 * Strategy identifiers (`00_globals.md` §0 strategy inventory).
 *
 * Re-exported from the canonical config schema so there is a single source of
 * truth for the `StrategyId` union (avoids drift between config and core).
 * Strategy modules, their parameter schemas, and selection/exit behavior land in
 * tasks 0280–0350 (`01`–`07`).
 */

export type { StrategyId } from '../../config/canonical.js'
