# 0360 — Full Postgres schema + store idempotency

**Phase:** 5 — Sidecars full
**Depends on:** 0080
**Spec references:** `14_persistence_and_recovery.md` §3 (schema), §4 (idempotency at the store), §6 (durability); `00_globals.md` §8.3 (output variables)

## Objective
The complete fleet schema: `orders`, `fills`, `positions`, `funding_events`, `pnl`, `kill_switch`, `reconciliation` joining the existing `intents`/`intent_wal` — every table `instance_id`-scoped, every write idempotent on its natural key, migrations committed, and repositories implementing the full `Repo` port surface the sidecar tasks (0370–0410) build on.

## Context for the agent
Can start any time after 0080 — do not wait for Phase 4. Natural idempotency keys (`14` §4): `intentId`, `clientOrderId`, `(symbol, fundingTime)` for funding events — duplicate WS deliveries and reconnect replays must be no-op upserts, never double counts. The `pnl` table columns follow the canonical output registry (`00_globals` §8.3): `p_entry`, `p_exit`, `p_avg`, `delta_pnl`, `funding_pnl`, `fee_cost`, `net_pnl`, `exit_reason`, `error_code`, `hold_duration_s`, `fill_count`, `funding_received`, `t_drop_offset_s` — cross-strategy comparable by construction. `synchronous_commit` on for `intent_wal` (`14` §6). Wire the execution layer's existing in-memory facts (orders, fills from 0230; positions/funding from 0240; kill switch from 0140) into persistence through repos — async off the hot path, same pattern as the WAL forwarder.

## Scope
- In scope:
  - `src/persistence/db/schema.ts` extended with the seven tables per `14` §3, enums for `exit_reason`/`error_code` mirrored from 0040's unions (single source: generate or static-assert equality), migrations.
  - Repositories per aggregate with idempotent upsert semantics; instance-scoping enforced in every query (a repo constructed with an instance triple can't read another's rows — test it).
  - Persistence wiring: order/fill events → `orders`/`fills`; position snapshots → `positions`; funding tracker → `funding_events`; kill-switch transitions → `kill_switch`; S2 tracker state storage (used by 0370).
  - Duplicate-delivery integration tests (replay the same event stream twice → identical row counts).
- Out of scope: recovery logic (0370), reconciliation/pnl row *production* (0400/0390 — the tables exist now, writers come there), fleet rollup queries (0410).

## Implementation notes
Static-assert enum parity between TS unions and pg enums with a unit test iterating both — schema drift on `error_code` values is exactly the R12-class defect. Keep repos thin (Drizzle queries, no logic); anything smart belongs in the consuming layer.

## Verification (definition of done)
1. `npm run verify` — green; `npm run test:integration` (docker) — green.
2. Idempotency tests: double-insert by each natural key → single row; replaying a full e2e scenario's persistence stream twice → identical table counts.
3. Instance isolation test: two repos with different triples — writes from one invisible to the other.
4. Enum-parity test passes for `exit_reason` and `error_code`.
