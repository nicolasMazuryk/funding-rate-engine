# 0010 — Repo scaffold, tooling, and `npm run verify`

**Phase:** 0 — Foundation
**Depends on:** none
**Spec references:** `0000_agentic-development-environment.md` §1 (Repository scaffolding & tooling), §3 (The verification loop); `08_system_overview.md` §6 (Tech stack), §7 (Project layout); `17_testing.md` §1 (Test layers)

## Objective
A green, strict-TypeScript Node.js repository skeleton with formatter, linter, typechecker, Vitest, one passing smoke test, and a single `npm run verify` command that runs every check. This is the minimal foundation every later task builds on and verifies against; nothing else can start until this loop exists.

## Context for the agent
Greenfield repo — only `docs/` and `prompt.md` exist. The project is a crypto funding-rate trading engine (specs in `docs/specs/`), but **this task builds no product code**. Layout follows `08_system_overview.md` §7 with all source under `src/` (assumption A7 in `docs/plan/ROADMAP.md`): `src/core/{runtime,intent,strategies,events,ports}`, `src/adapters/exchanges/`, `src/persistence/`, `src/execution/`, `src/risk/`, `src/accounting/`, `src/config/`, `src/main.ts`, `test/{unit,integration,e2e}`. Linter choice is ESLint (typescript-eslint) + Prettier (assumption A2). CI is deliberately **not** part of this task (deferred to 0530).

## Scope
- In scope:
  - `package.json` (Node ≥ 20, `"type": "module"`), lockfile, deps: `typescript`, `vitest`, `eslint` + `typescript-eslint`, `prettier`. Product deps (`ccxt`, `zod`, `pino`, etc.) are added by the tasks that first use them — do not preinstall.
  - `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`.
  - ESLint + Prettier configs; directory skeleton above with `.gitkeep` or placeholder `index.ts` files that compile.
  - One smoke unit test (e.g. asserts a trivial exported function) under `test/unit/`.
  - npm scripts: `typecheck`, `lint`, `format:check`, `test`, and `verify` = typecheck + lint + format:check + test (fail-fast, non-zero exit on any failure).
  - `.gitignore` (node_modules, dist, `.env`, local WAL files, coverage).
- Out of scope: CI workflows (0530), CLAUDE.md / `.claude/` (0020), any product types or logic (0030+), Postgres/docker (0080).

## Implementation notes
Keep it minimal — no build step needed (Vitest runs TS directly; `typecheck` uses `tsc --noEmit`). Ensure `npm run verify` output is unambiguous: each sub-step prints its name and the command exits non-zero on the first failure. Placeholder files must not trip lint rules (no empty-file or unused-export warnings).

## Verification (definition of done)
1. `npm install` — succeeds from a clean checkout.
2. `npm run verify` — exits 0; output shows typecheck, lint, format check, and 1 passing test.
3. Introduce a deliberate type error in a scratch file, run `npm run verify` — exits non-zero; revert.
4. `git status` — no untracked build artifacts (dist/coverage ignored).
