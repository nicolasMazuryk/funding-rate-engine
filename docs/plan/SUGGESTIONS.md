# SUGGESTIONS — Improvement Log

Things agents noticed outside their current task: worth building, improving, or fixing. Logged, not implemented — the human decides what gets picked up (typically by promoting an entry to a new task file in `docs/plan/tasks/`). Format and rules: `docs/plan/EXECUTION.md` §Suggestions log.

- **[area/file]** — What you noticed, and why it matters. Proposed solution in one line. `[priority: critical|high|med]`
- **[deps/drizzle-kit]** — `npm install` reports 5 advisories (4 mod, 1 high) from `drizzle-kit`'s bundled, deprecated `@esbuild-kit/*` (merged into `tsx`); dev-only, off the runtime path. Revisit when CI lands (0530): pin/upgrade drizzle-kit or run migrations via a `tsx`-based path. `[priority: med]`
- **[composition/main.ts]** — No composition root / `main.ts` exists yet; preflight deps (`riskGate`/`killSwitch`/`initialBalance`/`accountSetupComplete`) are wired only in `test/helpers/build-skeleton-engine.ts`. Real wiring (fetch live balance, read `config.risk` limits, `KILL_SWITCH` env → initial state, run `11` §1 account setup then set `accountSetupComplete`) belongs to the future composition task. `[priority: med]`
- **[risk/breaker + daily-loss]** — Preflight `breakerOpen` is hardcoded `false` (breakers land 0380) and `max_daily_loss_usd` from `config.risk` is parsed but unenforced by the gate (needs realized-P&L accounting). Wire both when circuit breakers + accounting exist. `[priority: med]`
