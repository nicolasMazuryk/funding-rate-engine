# 0100 — Canonical config schema, bounds, unit guards

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0010
**Spec references:** `09_configuration.md` §1–§3, §8; `00_globals.md` §8.2 (parameter registry), §9.1 (bounds), §9.2 (unit-mismatch protection), §11 (R4, R6); strategy files `01`–`07` §5 (parameter tables)

## Objective
The single canonical parameter schema for all seven strategies — names, units, defaults, and bounds exactly as `00_globals` §8.2/§9.1 — with Zod validation, the generated live (camelCase) schema, unit guards (`unit_suspect_fraction`, fraction bounds), unknown-key rejection, the `.env` schema, and the round-trip test. This kills the unit-mismatch defect class before any strategy code exists.

## Context for the agent
The classic defect this prevents: `takeProfitPct = 0.003` (a fraction) read as percent — a 100× TP shrink (`00_globals` §9.2/R4). Binding rules: the live schema is **generated** from one canonical definition, never hand-written; unknown key = hard error; every bound in §9.1 enforced; `funding_threshold` legacy alias accepted for S6 with a warning (R6). Schema defaults come from §8.2 (assumption A6 in ROADMAP: committed example configs carry each strategy file's *proposed* values; the schema carries *schema defaults*).

## Scope
- In scope:
  - Deps: `zod`, `yaml`, `dotenv`.
  - `src/config/canonical.ts`: one declarative table — per strategy, per parameter: live key, unit, bounds, default, signedness — from which per-strategy Zod schemas are derived programmatically (this is the "generated from one canonical schema file" requirement).
  - All §9.1 bounds, including: `exit_offset_seconds > 5`, `deadline_seconds 10–3600`, `take_profit_pct` unit guard (`< 0.05` → error code `unit_suspect_fraction`), `retracement_pct` fraction (0,1] and reject `> 1.0`, `ladder_bottom_mult > ladder_top_mult`, `sl_multiplier > limit_offset_mult` (S4.2a), S3a co-run guard (needs the full instance view — implement the check function here; it is invoked from the pipeline in 0110), S6 signed-any threshold, `mainSide` required.
  - Per-strategy key whitelists: `stopLossPercent` on S3a only, `slMultiplier` never on S3a — the wrong key is an error, not ignored (`04` §5, `09` §3).
  - Strategy YAML container shape per `09` §3 (`instance`, `sizing`, `strategy_params`, `risk`, `symbols`).
  - `EnvSchema` per `09` §2 (identity, secrets presence by exchange, `DATABASE_URL`, `LOG_LEVEL`, `KILL_SWITCH`).
  - S6 legacy alias `funding_threshold` → `fundingThresholdPercent` with warning (R6).
  - Round-trip test (`00_globals` §9.2 item 4): every canonical parameter emitted to the live schema, re-parsed, compared numerically.
  - Committed example configs: `config/<strategy>-binance.yaml` for all 7 strategies with proposed values.
- Out of scope: exchange profiles + delta merge + loading pipeline + cross-checks (0110), consuming config in the engine (0130+).

## Implementation notes
Drive everything from the one table — tests can iterate it (e.g. "every parameter row has a unit" is a test, mirroring §9.2 item 2). Error messages must name the exact key and reason (`09` §5: log exact key + reason, exit 1 — the exit is the pipeline's job in 0110; here throw typed errors). Keep validators pure functions: `parseStrategyConfig(yamlText, strategyId)`.

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit tests demonstrate, at minimum: `take_profit_pct: 0.003` → `unit_suspect_fraction`; `retracement_pct: 50` → error; `exit_offset_seconds: 4` → error (R2 bound); unknown key `stopLossPercent` on a S2 config → error; `funding_threshold` on S6 → parsed with warning; all 7 example configs parse clean.
3. Round-trip test passes for every parameter of every strategy.
