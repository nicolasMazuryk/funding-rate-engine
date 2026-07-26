# 0520 — Fleet config generation + operations runbook

**Phase:** 8 — Fleet
**Depends on:** 0420, 0430, 0440, 0460, 0510 (0450 / Gate.io skipped — venue dropped, STATUS 0450)
**Spec references:** `16_fleet_deployment.md` §2 (the 5×6 fleet), §4 (operating the fleet), §5 (what deployment does not add); `09_configuration.md` §7 (config change management); `15_accounting_and_reconciliation.md` §5 (rollup usage)

## Objective
The full fleet made concrete: a generator that enumerates the strategy×venue matrix into per-instance env files + strategy YAMLs + compose services (spec `16` §2 illustrates 30 cells over 6 venues; Gate.io was dropped, so the real matrix is 7 strategies × **5** venues minus the cells per-venue capability facts from Phase 6 forbid, e.g. WS-order availability), a secrets template per sub-account, and the operations runbook covering deploy, config-change-as-redeploy, per-instance and fleet-wide kill-switch operation, and rollup queries.

## Context for the agent
Adding a strategy or venue is config + secrets, no code (`16` §2). The matrix must honor constraints from config validation: S3a never co-runs with LONG strategies *in one instance* (each instance is one strategy, so the matrix itself is fine — the guard protects against misconfiguration); WS-mandatory strategies (S1-WS/S2/S6) can only be generated for venues whose profile provides WS orders or sets `ws_order_rest_fallback` (facts from 0420–0460) — the generator must **refuse** invalid cells with a clear message, not emit them. Per-exchange deltas apply through the normal merge (nothing bespoke per venue). Fleet-wide "pause all" is just toggling every instance's kill switch — no shared runtime coupling (`16` §4/§5).

## Scope
- In scope:
  - `scripts/generate-fleet.ts` (`npm run fleet:generate`): matrix definition file (which strategies × which venues) → `env/<strategy>-<venue>.env` templates (identity + secret placeholders), instance YAMLs from the canonical proposed-value configs (0100's examples parameterized per venue deltas), `docker-compose.fleet.yml` services (one per cell, same image, per-cell WAL volume); validation pass over every generated config through the real loader (0110) before writing.
  - Secrets handling: `.env` templates with placeholders only — real secrets never generated or committed; README section on sub-account key provisioning per venue.
  - `docs/runbook.md`: deploy/upgrade (config change = redeploy, config-hash audit trail), kill-switch ops (per-instance toggle + pause-all script `scripts/fleet-pause.ts` flipping the persisted state per instance), monitoring pointers (Pino bindings, rollup queries from 0410, reconciliation alerts), incident basics (orphan alerts, breaker-open, `close_pre_funding_failed` halt per `07` §3).
  - Generator tests: full-matrix generation validates every emitted config through the loader; an invalid cell (WS-mandatory strategy on a no-WS-orders venue) is refused with the reason.
- Out of scope: real secret values, cloud orchestration, live fleet startup (ops), CI (0530).

## Implementation notes
Drive the generator from data the repo already owns (strategy list from the registry, venue capabilities from `exchanges.yaml`) so the matrix can never drift from reality. `fleet-pause` operates via the persisted kill-switch state (DB), matching `13` §2 semantics — document that `.env` `KILL_SWITCH` is bootstrap-only.

## Verification (definition of done)
1. `npm run verify` — green; generator tests pass including the refusal case.
2. `npm run fleet:generate` over the full matrix: every generated YAML passes the real config loader; compose file has one service per valid cell; zero secrets in any generated file (grep).
3. `docker compose -f docker-compose.fleet.yml config` validates.
4. Runbook exists and every command it names exists (grep-check against `package.json`/`scripts/`).
