# STATUS — Task Ledger

One row per task. Agents update this file only (see `docs/plan/EXECUTION.md`). Statuses: `todo` | `in_progress` | `done` | `blocked`.

**Notes = forward-looking signal only** — deferrals, spec deviations, cross-cutting decisions, and gotchas a later task needs. Anything derivable from the code, specs, or commit/PR does NOT belong here. Notes are **pruned once they stop being forward-looking**: a task is `done` and no `todo` task depends on the note ⇒ delete it. Detail belongs in the commit, `docs/plan/SUGGESTIONS.md`, `src/adapters/CLAUDE.md`, or `docs/testnet-notes.md`. Keep terse.

The pre-0440 per-row notes were pruned in bulk; the full prior text is in git history (`git show HEAD:docs/plan/STATUS.md`).

## Carry-forward

The only cross-task memory kept here. Everything else: read the code, the specs, `SUGGESTIONS.md`, `src/adapters/CLAUDE.md`, or `docs/testnet-notes.md`.

### Binding conventions

- Strategy ids are short (`s1`, `s1-ws`, `s2`, `s3a`, `s4-1a`, `s4-2a`, `s6`) — NOT spec `09`'s `strategy_1_ws` form.
- `pnl` money columns are **quote currency** — deliberate deviation from `15` §8.3 (percent). Percent ratios must be recomputed from prices (analytics already does); a quote numerator over a percent denominator is a unit error.
- Funding-match tolerance is **±5 s** (ROADMAP A1; `11` §7's ±30 s superseded).
- `config/*.yaml` values are PROPOSED, not final.
- `src/risk/**` holds state and clock timers ⇒ never imported by `src/core/**`.
- Engine must NOT use `intentMachine.onTransition` (global singleton, leaks across engine instances).

### Open deferrals that touch remaining tasks

- **[high]** Binance `fundingIncome` is still a `NotImplemented` stub — land it in the first live/testnet-touching task (0470/0480).
- `max_daily_loss_usd` is parsed but NOT enforced (needs realized P&L aggregated across intents).
- 4 analytics metrics return `insufficient_data` (`P_avg` vs `P_ref`; S3a drop-depth ÷ |F|; S6 realized PRE overhead bp; S6 MAIN slippage) ⇒ **0500 cannot fully gate S6 PRE overhead / MAIN slippage** until that capture lands.
- S6 `PRE_FUNDING_DELTA` books 0 (PRE fill px/qty not threaded out of the entry sub-machine); the settled charge lands in `FUNDING_PRE` — canary-audit at 0500.
- S6 live settled-rate timing (a `FundingSettled` lagging the MAIN fill) → the `amount`-derived fallback is an 0490 shadow concern, not coded.
- Reconciliation gaps: balance dimension deferred; fills check covers entry rung 1 only; the per-close position check assumes flat (concurrent same-symbol intents ⇒ spurious orphan).
- `s3a` + LONG co-run guard is single-instance only — fleet-level enforcement is 0520.
- `config/exchanges.yaml`: WS URLs + `rate_limit_weight_per_minute` for Bitget/Gate.io/KuCoin are placeholders — fix in 0440–0460.

### New-venue recipe (0440–0460)

- Read the `src/adapters/CLAUDE.md` venue-quirk table + `docs/testnet-notes.md` FIRST.
- Extend the venue **data maps**, not branches: `EXCHANGES` enum, `scripts/capture.ts` driver map, `scripts/testnet.ts` venue map, `main.ts buildAdapter`.
- Acceptance proof: `git diff --stat -- src/core/` empty; `--venue binance` testnet still 8/8.
- Bybit's `fundingIncome` (ccxt `fetchLedger` → `SETTLEMENT`) is the working reference impl.
- Size `rate_limit_weight_per_minute` so the reserved order lane equals the venue's real order/s cap (Bybit 6000 @ 10 %, OKX 1200 @ 50 %).

### Env / tooling gotchas

- Migrations are hand-authored (drizzle-kit needs a TTY); its bundled `@esbuild-kit/*` advisories → revisit at 0530.
- `test:integration` + e2e need Docker Postgres, opt-in, outside `verify`; host port 5432 is often occupied — use an alt port.
- Node CLI entries need `scripts/register-ts.mjs` + `--experimental-transform-types`.
- Never actually ran: `crash-matrix.e2e.test.ts` DoD #9 (kill switch survives crash) typechecks only; Bybit testnet DoD step 3 never ran with real creds (credential-free skip path only).

## Tasks

| ID | Task | Status | Notes |
|---|---|---|---|
| 0010 | repo-scaffold-and-verify | done | |
| 0020 | agent-context-layer | done | |
| 0030 | core-events-and-ports | done | |
| 0040 | fsm-engine | done | FLAGGED, unreviewed: `NO_POSITION` reachable from `SUBMITTING_ENTRY`+`MONITORING`, not `MONITORING`-only per `12` §5 diagram. |
| 0050 | clock-and-scheduler | done | |
| 0060 | fake-adapter-minimal | done | |
| 0070 | local-wal | done | |
| 0080 | postgres-drizzle-minimal | done | pg repo pool `max:1`: un-awaited upserts must serialize or a late MONITORING overwrites CLOSED. |
| 0090 | walking-skeleton-slice | done | |
| 0100 | config-canonical-schema | done | |
| 0110 | config-exchange-profiles | done | |
| 0120 | sizing-precision-denomination | done | |
| 0130 | guards-and-opportunity-finder | done | |
| 0140 | preflight-risk-gate-kill-switch | done | |
| 0150 | cost-model | done | |
| 0160 | sim-exchange-fault-injection | done | |
| 0170 | replay-and-trace | done | |
| 0180 | claude-workflows-and-hooks | done | |
| 0190 | binance-clients-and-markets | done | |
| 0200 | error-taxonomy-and-rate-limiter | done | |
| 0210 | binance-public-ws | done | |
| 0220 | binance-private-ws | done | |
| 0230 | binance-order-manager | done | |
| 0240 | account-setup-and-trackers | done | |
| 0250 | fixture-capture | done | |
| 0260 | binance-testnet-tier | done | |
| 0270 | e2e-harness | done | |
| 0280 | strategy-s1 | done | |
| 0290 | funding-gate | done | |
| 0300 | strategy-s1-ws | done | |
| 0310 | strategy-s2 | done | |
| 0320 | strategy-s3a | done | |
| 0330 | strategy-s4-1a | done | |
| 0340 | strategy-s4-2a | done | |
| 0350 | strategy-s6 | done | |
| 0360 | postgres-schema-full | done | |
| 0370 | crash-recovery-full | done | |
| 0380 | breakers-and-flatten | done | |
| 0390 | accounting | done | |
| 0400 | reconciliation | done | |
| 0410 | analytics | done | |
| 0420 | adapter-bybit | done | |
| 0430 | adapter-okx | done | |
| 0440 | adapter-bitget | todo | |
| 0450 | adapter-gateio | todo | |
| 0460 | adapter-kucoin | todo | |
| 0470 | live-tier-harness | todo | |
| 0480 | live-verification-binance | todo | |
| 0490 | s6-shadow | todo | |
| 0500 | s6-canary | todo | |
| 0510 | docker-fleet-packaging | todo | |
| 0520 | fleet-config-and-runbook | todo | |
| 0530 | ci-pipeline | todo | |
