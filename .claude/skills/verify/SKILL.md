---
name: verify
description: >
  Run and interpret the project's verification gate (`npm run verify` = typecheck +
  biome check + vitest). Use before any commit, or whenever you need to confirm the
  repo is green. Triggers on "/verify", "run verify", "is the repo green".
---

Run `npm run verify`. It is three sequential steps: `typecheck` (`tsc --noEmit`),
`check` (`biome check .`), `test` (`vitest run` — unit + scenario + golden tiers;
integration/e2e are excluded by design, see `test/CLAUDE.md`).

## On success

Report green. Nothing else to do — this is the gate `docs/agent-workflow.md` requires
before every commit.

## On failure — isolate the failing stage

Exit non-zero tells you a stage failed but not which without reading output. Re-run the
stage in isolation to get an unambiguous, structured result:

- `npm run typecheck` — `tsc` prints `path:line:col - error TSxxxx: message`. Fix the
  root cause at that location; do not add `as any`/`@ts-ignore` to silence it.
- `npm run check` — `biome check .` prints `path:line:col lint/rule` or a formatting
  diff. `npm run format` auto-fixes formatting; lint findings still need a manual fix
  unless the rule is a project-approved override (`biome.json`).
- `npm run test` — Vitest reports the failing file + test name + assertion diff. A
  **golden** test failure (`test/golden/**`) means the recorded trace diverged from
  current core behavior — read the diff before blessing a new trace (`npm run replay
  -- --promote`, see the `replay` skill); do not bless a divergence you have not
  understood.

## Rules

- Never mark a task done on a red `npm run verify`.
- Do not skip a stage to "save time" — all three gate every commit (`CLAUDE.md`
  "Commands").
- Integration tests (`npm run test:integration`, needs `docker compose up` for Postgres)
  are **not** part of `verify` — only run them when the task touches persistence.
