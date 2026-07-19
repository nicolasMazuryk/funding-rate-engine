/**
 * Strategy identifiers (`00_globals.md` §0 strategy inventory).
 *
 * PLACEHOLDER: this is only the closed `StrategyId` union. Strategy modules,
 * their parameter schemas, and selection/exit behavior land in tasks 0280–0350
 * (`01`–`07`). Nothing strategy-specific beyond this identifier belongs here.
 */

export type StrategyId = 's1' | 's1-ws' | 's2' | 's3a' | 's4-1a' | 's4-2a' | 's6'
