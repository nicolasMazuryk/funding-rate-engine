# CLAUDE.md — funding-drop

Event-driven perpetual-futures **funding-harvest** trading engine. One running instance = one exchange, one strategy, one sub-account. Ports-and-adapters architecture with a **pure core**: I/O and venue quirks live at the edges; the strategy runtime is deterministic given its event stream. Keep the core pure; keep the mess at the edges.

## Spec navigation

Specs are the source of truth; the task file summarizes, the specs govern detail. Behavior lives in the strategy files, the live-system shape in `08`–`17`.

| Need | Read |
|---|---|
| Strategy behavior (selection/entry/exit/P&L) | `docs/specs/01`–`07` strategy files + `00_globals.md` (shared: timeline, drop model, sizing, safety, registries) |
| Architecture, tech stack, event spine, patterns, layout | `docs/specs/08_system_overview.md` |
| Config: `.env` + YAML, Zod, fail-loud startup | `docs/specs/09_configuration.md` |
| Exchange adapters, market data, precision, rate limiter, public WS | `docs/specs/10_exchange_adapters_and_market_data.md` |
| Order management, order FSM, account state, private WS | `docs/specs/11_execution_and_account_state.md` |
| Strategy runtime, scheduler, intent FSM | `docs/specs/12_strategy_runtime_and_intent_lifecycle.md` |
| Kill switch, breakers, flatten, failure catalog | `docs/specs/13_risk_and_failure_modes.md` |
| WAL, Postgres/Drizzle, crash recovery | `docs/specs/14_persistence_and_recovery.md` |
| Accounting, reconciliation, P&L | `docs/specs/15_accounting_and_reconciliation.md` |
| Fleet, sub-accounts, Docker | `docs/specs/16_fleet_deployment.md` |
| Testing tiers | `docs/specs/17_testing.md` |

Overall goal and build order: `docs/specs/0000_agentic-development-environment.md`. Deeper architecture and enforcement: `docs/architecture.md`.

## Commands

`npm run verify` is the universal gate — it must be green before any commit. It runs:

| Command | Does |
|---|---|
| `npm run verify` | `typecheck` + `check` + `test` — the gate |
| `npm run typecheck` | `tsc --noEmit` (strict TS) |
| `npm run check` | `biome check .` (lint + format check) |
| `npm run format` | `biome check --write .` (apply lint/format fixes) |
| `npm run test` | `vitest run` |
| `npm run test:integration` | `vitest run --config vitest.integration.config.ts` (needs Docker Postgres; not part of `verify`) |
| `npm run test:live -- --subaccount <id> [--venue <v>\|--all-venues] [--suite <self-test\|fill-test\|funding-test>] [--parallel] [--json]` | live tier (task 0470): **real orders, real money** on a production venue, capped at 25 USD/order + 50 USD exposure, always torn down flat. Human-run only, never automated; creds from the gitignored `config/subaccounts.secrets.yaml` (absent ⇒ all checks skip, exit 0). Venue quirks: `docs/live-notes.md` |
| `npm run replay -- <trace> [--expect <golden>] [--json]` | replay a recorded trace through the core, no live venue needed (task 0170) |
| `npm run analytics -- [--json] [--exchange\|--strategy\|--subaccount <id>] [--from\|--to <ms>]` | read-only trade analytics + fleet rollup over the shared DB (`15` §4/§5, task 0410); needs `DATABASE_URL`, no venue credentials |
| `npm start` | boot an instance (composition root `src/main.ts`); fail-loud startup (`09` §5), clean SIGTERM shutdown |
| `ADAPTER=sim npm start` | dev smoke (task 0280): boot against the credential-free sim venue, no live orders — used to verify boot + SIGTERM without creds. `ADAPTER` defaults to `binance` |

Do not reference commands that do not exist yet; add each command in the task that creates its tooling.

## Claude Code workflow layer (task 0180)

- **Skills** (`.claude/skills/`): `/verify` (run + interpret `npm run verify`),
  `/replay` (wrap `npm run replay`, incl. `--json` interpretation), `/scenario` (run one
  `test/scenarios/**` fault-injection scenario in isolation), `/testnet` (venue testnet
  tier), `/live-tier` (real-money live tier — usage, verdict reading, hard rules).
- **Hook**: `.claude/settings.json` runs `.claude/hooks/post-edit-check.mjs` after every
  edit — scoped `biome check` + full `tsc --noEmit`, fast feedback, not a `verify`
  substitute.
- **Subagents** (`.claude/agents/`): `spec-navigator` (read-only "which spec section
  governs X" lookup), `test-writer` (writes a failing test first, matching tier
  conventions, before the implementation exists).
- Tier pyramid and when to add which test: `docs/testing-strategy.md`. Repo-specific
  harness conventions: `test/CLAUDE.md`.

## Core Philosophy

**KISS · DRY · YAGNI — in that order of priority.**

- Prefer the simplest solution that works. Less code > clever code.
- Delete code aggressively. The best code is no code.
- Avoid overengineering

## Architecture rules (brief — see `docs/architecture.md` for depth + enforcement)

- **Purity boundary.** `src/core/` imports no I/O library (no `ccxt`, no venue lib, no `pg`/Drizzle, no `ws`). The core depends only on ports (interfaces). This is what makes the runtime testable in isolation. (Import-boundary lint lands in task 0030.)
- **WAL-before-side-effect.** Every state transition is durably appended to the local WAL before the side effect it gates, so a crash resumes deterministically and Postgres latency stays off the hot path.
- **KISS / DRY / less code.** One config schema, one adapter interface, one FSM engine (intents + orders), one repository pattern. No speculative generality.
- **Dependencies point inward.** Domain logic never imports frameworks, ORMs, or SDKs. I/O lives at the edges; the core is pure functions and plain data.
- **Functions do one thing at one level of abstraction.** A function either orchestrates (calls named steps) or does work (no orchestration). Mixing the two is the main source of unreadable code.

## Change discipline
- **Follow the local dialect.** Match the surrounding file's patterns, naming, error handling, and structure.

## Errors & failure
- **Fail loud, fail early.** Instruments, precision, and config are validated at startup; a bad instrument or config aborts the process before any order.

## External docs (Context7)

- **Use Context7 for library/API documentation and anything that can be fetched from internet.** Before writing or reviewing code
  against a third-party dependency (`ccxt`, Drizzle, Zod, Vitest, Biome, `ws`, `pg`,
  Docker/Postgres tooling), pull the current docs via the Context7 MCP server rather
  than relying on recall. Training data goes stale; the venue and ORM APIs move.
- **When it's required, not optional:** adapter work against exchange SDKs, any version
  bump, any error message that looks like an API signature change, and any "does this
  method exist" question. A wrong assumption about a venue SDK is a live-order bug.

## Conventions

- **Conventional commits, referencing the task ID.** E.g. `feat(core): event bus, ports, purity lint [task 0030]`. One task = one commit (or a small series, each tagged). Never mix tasks.
- **Units are load-bearing** (`00_globals.md` §1.2). A value in the wrong unit is a **loader error**, not a warning:
  - **percent** — `0.3` means 0.30% (30 bp). All thresholds, TP/SL distances, fees, slippage.
  - **fraction** — `0.5` means 50%. Used **only** for `retracementPct`; no other parameter is a fraction.
  - **seconds** — integers unless the name is suffixed `Ms`.
  - **signed vs absolute** — stated per parameter row (e.g. `negativeFundingThresholdPercent` is signed-negative).
- All timestamps are **epoch milliseconds, UTC, as `number`** (suffix `Ms`). No `Date` objects
