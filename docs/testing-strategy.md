# Testing Strategy

The test pyramid for this engine, why each tier exists, what it costs, and when a task
must add to which tier. Source of truth for tier *behavior*: `docs/specs/17_testing.md`
(+ `00_globals.md` by reference) and spec `0000_agentic-development-environment.md` §5
("the stakes"). This doc is the working index; where it and `17` disagree, `17` wins.
Tier mechanics specific to this repo (harness helpers, fixture format, determinism
rule) live in `test/CLAUDE.md` — this doc does not restate those.

## The pyramid

```
unit  →  sim scenario  →  golden replay  →  integration (fixture/testnet)  →  e2e  →  live
```

Each tier down costs more (credentials, wall-clock, real money) and proves something
the tier above cannot.

| Tier | Path | Proves | Needs | Cost | In `npm run verify`? |
|---|---|---|---|---|---|
| **Unit** | `test/unit/**` | pure-core logic is correct in isolation: FSM transitions, guards, sizing, cost model, config validation | nothing (in-memory ports) | fast, deterministic | yes |
| **Sim scenario** | `test/scenarios/**` | the core survives a *misbehaving* venue — one file per `13` §6 failure-catalog row, run through the sim adapter + virtual clock | sim venue + virtual clock + engine (still zero I/O) | fast, deterministic | yes |
| **Golden replay** | `test/golden/**` | a captured event trace still reproduces byte-identical transitions when replayed through the current core — regression net for core behavior changes | recorded trace fixture | fast | yes |
| **Integration** | `test/integration/**` | a real adapter honors the `ExchangeAdapter` port against a real venue (testnet) or a real Postgres | Docker Postgres and/or venue testnet credentials | slower, networked | no — `npm run test:integration`, opt-in |
| **Testnet** | per-venue, inside integration | venue-specific quirks (precision, error mapping, WS reconnect) hold against the real exchange, no money at risk | venue testnet keys | slower, networked | no |
| **E2E** | `test/e2e/**` | full instance wiring (scheduler → intent → execution → persistence) end to end | simulated venue + real Docker Postgres + real local WAL | medium | no — `npm run test:e2e`, opt-in |
| **Live** | `0470`–`0500` harness | production behavior under real money, hard-capped | live keys, hard caps, auto-flatten | real money, slow | no — explicit command only, never automated |

## What each tier is for (when a task must add one)

- **Unit** is the bulk of coverage and the default choice: any pure-core behavior
  (`12_strategy_runtime_and_intent_lifecycle.md`, `13`, sizing, config) gets a unit test
  in the same task that implements it. One test per enum value for FSM terminal states
  so no `exit_reason`/`error_code` is unreachable or ambiguous (`17` §2).
- **Sim scenario** is added when a task implements or exercises a failure mode from the
  `13` §6 catalog (partial fill, reject, disconnect, rate limit, duplicate/out-of-order
  event, funding-fee timing, crash mid-intent). Reuse the DSL/harness in
  `test/scenarios/` — see `test/CLAUDE.md` for the conventions and helper names.
- **Golden replay** is added/updated when a task changes core behavior that a captured
  trace exercises — bless a new trace via `npm run replay -- --promote` (the `replay`
  skill) only after understanding *why* the trace diverged, never reflexively.
- **Integration** is added by the task that builds a real adapter or persistence layer
  against its real dependency (Binance adapter tasks `0190`–`0260`, Postgres task
  `0080`/`0360`). Gated on credentials/Docker; never wired into default `verify`.
- **E2E** now exists (task `0270`): the harness in `test/e2e/harness.ts` boots a full
  instance on the virtual clock + sim venue but real Docker Postgres + real local WAL.
  Populated immediately before the first real strategy, and grown per strategy
  (`0280`–`0350`) — one scenario file per strategy plugging into `harness.ts`.
- **Live** is only ever run via the documented harness commands in tasks `0470`–`0500`
  — never scripted, automated, or expanded in scope by an unrelated task
  (`docs/plan/EXECUTION.md` "Live tiers" rule).

## Determinism (load-bearing, all pre-live tiers)

Unit, scenario, and golden tests never touch wall-clock time or real randomness — time
advances only via the virtual clock, and every fault is a deterministic function of
`clock.now()` or event order. Two runs from fresh state must be byte-identical. Full
rule and enforcement: `test/CLAUDE.md` "Determinism rule".

## Commands

| Command | Runs |
|---|---|
| `npm run verify` | typecheck + `biome check` + `npm run test` (unit + scenario + golden) — the universal gate |
| `npm run test` | `vitest run` (unit + scenario + golden tiers only) |
| `npm run test:integration` | `vitest run --config vitest.integration.config.ts` (needs `docker compose up` for Postgres) |
| `npm run test:e2e` | `vitest run --config vitest.e2e.config.ts` — full-instance e2e tier (needs `docker compose up` for Postgres + local WAL) |
| `npm run replay -- <trace> [--expect <golden>] [--json]` | replay a trace against the current core; see the `replay` skill |

See the `verify`, `replay`, and `scenario` skills (`.claude/skills/`) for how to invoke
and interpret each of these as an agent action.
