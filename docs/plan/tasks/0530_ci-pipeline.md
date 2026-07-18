# 0530 — CI pipeline (deferred foundation item lands)

**Phase:** 8 — Fleet
**Depends on:** 0010 (deliberately scheduled last — see ROADMAP §3, decision 4 / assumption A8)
**Spec references:** `0000_agentic-development-environment.md` §3 (CI gates mirror the same commands); `17_testing.md` §6 (CI)

## Objective
The deliberately-deferred CI lands: a pipeline that mirrors `npm run verify` exactly (local and CI verification identical, per spec 0000 §3), runs unit + e2e with a Postgres service, gates integration/testnet suites on credential availability, includes the canonical-schema round-trip test, and builds the Docker image. The deviation recorded in the ROADMAP closes here.

## Context for the agent
This was consciously deferred from Phase 0 (planning decision 4): the whole plan ran on local `npm run verify`. The binding requirement now: **CI runs the same commands** — no CI-only scripts, no divergence; if CI needs an extra step, it becomes an npm script first. `17` §6: `vitest run` for unit + e2e on every change; integration gated to testnet credentials; the round-trip test as the last line of defense on unit mismatches (it has run inside `verify` since 0100 — CI simply inherits it); coverage focus noted on FSMs/preflight/sizing/config. Assume GitHub Actions (repo hosting; adjust trivially if the remote dictates otherwise — record in STATUS notes).

## Scope
- In scope:
  - `.github/workflows/ci.yml`: jobs — `verify` (typecheck+lint+format+unit via the one script), `e2e` (Postgres service container, `npm run db:migrate` + `npm run test:e2e`), `docker` (build the 0510 image, no push), `testnet` (manual/scheduled trigger only, secrets-gated, `npm run test:testnet -- --venue binance`; skips cleanly when secrets absent).
  - Concurrency/cancellation config, Node version pinned to the repo's, npm cache.
  - Live tier explicitly **excluded** from CI (real money is never automated on push — document this in the workflow header comment and testing-strategy doc).
  - `docs/testing-strategy.md` + root `CLAUDE.md` updated: CI now exists; local/CI parity rule stated.
- Out of scope: CD/image publishing/deploy automation (ops decision), other venues' testnet jobs (same pattern, add when credentials are provisioned).

## Implementation notes
Parity is the whole point: the workflow must call `npm run verify`, `npm run test:e2e` — not reimplement them. The e2e job's `DATABASE_URL` points at the service container; keep defaults aligned with `docker-compose.yml` so local instructions transfer. Fork-safety: testnet job must not expose secrets to fork PRs (use environment protection).

## Verification (definition of done)
1. `npm run verify` — green locally.
2. Workflow YAML validates (`actionlint` or a dry parse) and every command it invokes exists in `package.json`.
3. Pushed branch shows green `verify`, `e2e`, and `docker` jobs on the hosted runner (evidence: run URL in STATUS notes). If the repo has no remote/Actions available at execution time, record that in STATUS.md and validate via `act` or documented equivalent — do not silently skip.
4. Coverage matrix note in `docs/plan/COVERAGE.md` flipped: the CI deferral is resolved (edit the two Deferred rows to point at this task as done).
