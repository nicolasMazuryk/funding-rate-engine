# 0510 — Docker image + fleet compose packaging

**Phase:** 8 — Fleet
**Depends on:** 0110, 0370
**Spec references:** `16_fleet_deployment.md` §1 (instance model), §3 (Docker packaging); `09_configuration.md` §1–§2 (identity via env), §5 (fail-loud boot); `14_persistence_and_recovery.md` §2.1 (WAL volume)

## Objective
One image for the whole fleet: a production Dockerfile for the engine, instance identity and behavior entirely from environment + mounted config, a compose file demonstrating multiple instances (same image, different env), a mounted volume per instance for its local WAL file, fail-loud boot surfaced through container exit, and stateless-container recovery proven (recreate a container mid-intent → recovers from DB + WAL volume + venue truth).

## Context for the agent
Binding rules (`16` §3): one image; one container per instance; identity from `EXCHANGE`/`STRATEGY`/`SUBACCOUNT` env + mounted `config/`; same `DATABASE_URL` everywhere (centralized DB); WAL file on a per-instance volume; bad config/instrument/auth aborts the container immediately (restart policy surfaces it — a broken instance never limps); all durable state in Postgres + the WAL volume. The full 30-instance enumeration and secrets layout is 0520 — here, the image + a 2–3 instance demonstration compose (e.g. `s1-binance` on sim-or-testnet profile + one more) proving the model.

## Scope
- In scope:
  - `Dockerfile` (multi-stage: build TS → slim runtime; non-root user; `NODE_ENV=production`), `.dockerignore`.
  - Entrypoint behavior: config load → fail-loud exit(1) with the exact key/reason on any validation failure (already the `09` §5 pipeline — verify it holds inside the container); SIGTERM → graceful shutdown (close streams, final WAL flush, forwarder drain attempt).
  - `docker-compose.fleet.yml`: 2–3 example services from one image with per-service `env_file` + read-only `./config` mount + named WAL volume each, plus the shared Postgres service (or external `DATABASE_URL`).
  - Container-recovery test (scripted, env-gated on docker): start an instance against the sim/testnet profile with a scripted in-flight intent, `docker rm -f`, recreate → recovery (0370) completes; WAL volume persistence asserted.
  - Image size/startup sanity documented.
- Out of scope: 30-instance config generation + secrets management + runbook (0520), orchestrators beyond compose, CI image publishing (0530).

## Implementation notes
The engine must resolve its WAL path from env (defaulting under a `/data` mount). Graceful-shutdown timeout must be shorter than compose's stop grace period. Fail-loud test: mount a config with an out-of-bounds parameter → container exits non-zero with the key named in logs — assert via `docker inspect` exit code + log grep.

## Verification (definition of done)
1. `docker build` succeeds; `npm run verify` unaffected.
2. Compose demo: `docker compose -f docker-compose.fleet.yml up` boots the example instances; each logs its `{exchange, strategy, subaccount, configHash}` binding (Pino bindings per `16` §4); clean `down`.
3. Fail-loud: bad-config instance exits non-zero within seconds, log names the exact key; restart policy shows restarts (never a running-but-broken container).
4. Recovery test: recreated container resumes the in-flight intent deterministically (trace-asserted), WAL volume intact.
