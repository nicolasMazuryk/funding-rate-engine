# 0080 — Postgres + Drizzle minimal: `intents`, `intent_wal`, forwarder

**Phase:** 1 — Walking skeleton
**Depends on:** 0070
**Spec references:** `14_persistence_and_recovery.md` §2.1 (forwarder), §3 (schema — `intents`, `intent_wal` rows), §4 (idempotency); `08_system_overview.md` §6 (Drizzle/pg)

## Objective
The centralized-Postgres tier of persistence, at walking-skeleton scale: Drizzle setup with migrations, the `intents` and `intent_wal` tables (with `instance_id` scoping columns), a minimal `Repo` port implementation, and the background forwarder that batch-upserts unshipped local WAL entries — idempotent by `(intentId, fromState, toState)`. Plus `docker compose` for a local Postgres and the first integration test.

## Context for the agent
Docker is available locally (planning decision). The hot path never blocks on Postgres — the forwarder is async, batches every ~200 ms or N entries, and survives Postgres being down (local file keeps growing, catch-up on reconnect: `14` §2.1). Only two tables now; the full schema is 0360. Every row carries `exchange`, `strategy`, `subaccount` (`instance_id` triple) — hardcode a dev triple until config lands (0110).

## Scope
- In scope:
  - Deps: `drizzle-orm`, `pg`, `drizzle-kit`; `docker-compose.yml` with Postgres + volume; `.env.example` documenting `DATABASE_URL`.
  - `src/persistence/db/schema.ts`: `intents` (per `14` §3 row: instance triple, strategy, symbol, `T_settle`, current state, `exit_reason`/`error_code`, config hash — nullable for now) and `intent_wal` (append-only transitions + `seq`, unique on `(intentId, fromState, toState)`).
  - Migrations generated and committed; `npm run db:migrate` script.
  - `src/persistence/repo.ts`: implements the `Repo` port from 0030 (upsert intent state, load non-terminal intents), scoped by instance triple.
  - `src/persistence/wal/forwarder.ts`: reads unshipped local entries (by `seq` watermark), upserts to `intent_wal`, advances watermark; on DB error, backs off and retries — never throws into the hot path.
  - Integration test (Vitest, tagged/located `test/integration/`) against docker Postgres: forward entries, kill/restart forwarder, no duplicates; `npm run test:integration` script; unit suite must keep passing without Docker running.
- Out of scope: full schema (0360), recovery sequence (0370), forwarder outage-hardening beyond simple retry (0370).

## Implementation notes
Idempotent upsert = `ON CONFLICT DO NOTHING` on the natural key. Watermark can live in a tiny sidecar file next to the WAL (or re-derive from `intent_wal` max seq on start — simpler, do that). Keep the integration test self-contained: it should create/truncate its own tables via migrations against `DATABASE_URL` (default to the compose port).

## Verification (definition of done)
1. `npm run verify` — green (unit tests skip DB).
2. `docker compose up -d` then `npm run db:migrate` && `npm run test:integration` — green: entries forwarded exactly once; re-running the forwarder over the same file adds zero rows; forwarder survives a stopped Postgres (starts failing quietly, catches up after `docker compose start`).
3. `docker compose down` — unit suite still green.
