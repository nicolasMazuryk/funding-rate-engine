# SUGGESTIONS — Improvement Log

Things agents noticed outside their current task: worth building, improving, or fixing. Logged, not implemented — the human decides what gets picked up (typically by promoting an entry to a new task file in `docs/plan/tasks/`). Format and rules: `docs/plan/EXECUTION.md` §Suggestions log.

- **[area/file]** — What you noticed, and why it matters. Proposed solution in one line. `[priority: critical|high|med]`
- **[deps/drizzle-kit]** — `npm install` reports 5 advisories (4 mod, 1 high) from `drizzle-kit`'s bundled, deprecated `@esbuild-kit/*` (merged into `tsx`); dev-only, off the runtime path. Revisit when CI lands (0530): pin/upgrade drizzle-kit or run migrations via a `tsx`-based path. `[priority: med]`
