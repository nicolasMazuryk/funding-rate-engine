# SUGGESTIONS — Improvement Log

Things agents noticed outside their current task: worth building, improving, or fixing. Logged, not implemented — the human decides what gets picked up (typically by promoting an entry to a new task file in `docs/plan/tasks/`). Format and rules: `docs/plan/EXECUTION.md` §Suggestions log.

- **[area/file]** — What you noticed, and why it matters. Proposed solution in one line. `[priority: critical|high|med]`

- **[docs/plan/tasks + package.json]** — Task verification steps say `npm run lint` (e.g. 0030 step 2), but no `lint` script exists — only `check` (= `biome check .`, which includes lint). Resolved locally by substituting `npm run check`. To stop every future task hitting the same snag, either add a `"lint": "biome lint ."` alias to `package.json` or sweep the task files to say `npm run check`. `[priority: med]`
