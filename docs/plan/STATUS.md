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

- `max_daily_loss_usd` is parsed but NOT enforced (needs realized P&L aggregated across intents).
- 4 analytics metrics return `insufficient_data` (`P_avg` vs `P_ref`; S3a drop-depth ÷ |F|; S6 realized PRE overhead bp; S6 MAIN slippage) ⇒ **0500 cannot fully gate S6 PRE overhead / MAIN slippage** until that capture lands.
- S6 `PRE_FUNDING_DELTA` books 0 (PRE fill px/qty not threaded out of the entry sub-machine); the settled charge lands in `FUNDING_PRE` — canary-audit at 0500.
- S6 live settled-rate timing (a `FundingSettled` lagging the MAIN fill) → the `amount`-derived fallback is an 0490 shadow concern, not coded.
- Reconciliation gaps: balance dimension deferred; fills check covers entry rung 1 only; the per-close position check assumes flat (concurrent same-symbol intents ⇒ spurious orphan).
- `s3a` + LONG co-run guard is single-instance only — fleet-level enforcement is 0520.
- **KuCoin's order path is now live-verified** (0470): real order → fill → reduce-only close, and the `position.settlement` funding **sign** confirmed against a real settlement. Its remaining venue shape: margin mode + leverage are stated **per order**, so an isolated submit needs `setMarginMode` + `setLeverage` first (0470 §KuCoin) — the engine's per-instrument account setup already does this; do not drop it on this venue.
- **Gate.io dropped** (user decision; 0450 skipped, no adapter will exist). `EXCHANGE_IDS` + `config/exchanges.yaml` are now a fixed **5**-key pair. `docs/specs/*` still say six venues — left untouched deliberately (historical source of truth); this note is the deviation record. `docs/plan/tasks/0450_adapter-gateio.md` is kept and marked SKIPPED so a later agent reads a decision, not a missing file.

### Live tier (0470) — what 0480+ must carry

- **[high] `flattenAll` cannot close a position it did not open on OKX.** The OKX adapter submits `tdMode: 'isolated'` on every order (no margin-mode switch exists there), so a reduce-only isolated close cannot see a **cross** position — OKX `51169`. `flattenAll` is also the kill switch's path (`13` §4), so a kill switch that cannot close every position it can *see* is a real gap. Bites only for positions opened outside the engine. Fix or accept explicitly at 0480.
- **Live caps are compiled-in and reduce-only-exempt** (`src/live/caps.ts`, 25 USD/order, 50 USD exposure). Exposure is reserved on submit and released only on a reduce-only fill — **never on cancel** — so a run that cancels and re-enters ratchets toward the ceiling (this is what limits `funding-test`'s entry ladder to two rungs). 0480 should reconcile the reservation against `getPositions()` rather than widening the cap.
- **Only `s6` sub-accounts exist** across the five venues; `s1`, `s1-ws`, `s2`, `s3a`, `s4-1a`, `s4-2a` have no provisioned sub-account in `config/subaccounts.yaml`. 0480/0520 need them before any per-strategy live run.
- **A Bitget Classic-mode sub-account cannot run this engine at all** (every v3/UTA read answers `40084`). Upgrade to UTA before provisioning one (0520).
- **`funding-test` on OKX is unrun** — it lists no 1 h symbols, so it needs a 4 h-aligned boundary (`00/04/08/12/16/20` UTC). Everything else about OKX funding is verified; the suite passes 7/7 on the other four venues.
- Live credentials live in gitignored `config/subaccounts.secrets.yaml` joined to committed `config/subaccounts.yaml` — **not** in `.env`. Keys are IP-pinned; from another IP every venue fails auth and preflight names the allowlist hypothesis.

### New-venue recipe (0460)

- Read the `src/adapters/CLAUDE.md` venue-quirk table + `docs/testnet-notes.md` FIRST.
- Extend the venue **data maps**, not branches: `EXCHANGES` enum, `scripts/capture.ts` driver map, `scripts/testnet.ts` venue map, `main.ts buildAdapter`.
- Acceptance proof: `git diff --stat -- src/core/` empty; `--venue binance` testnet still 8/8.
- Bybit's `fundingIncome` (ccxt `fetchLedger` → `SETTLEMENT`) is the working reference impl.
- Serialize price/qty **off the float grid** at the transport (`bitget/ws-orders.ts#toVenueNumber`): the core's tick rounding emits `62785.700000000004`, which Bitget rejects.
- Read the venue's error code off the **nested** envelope where the SDK throws one (Bitget: HTTP status at the top, venue code at `body.code`), and expect the WS trade API to use a different code space than REST. On KuCoin the HTTP status is not even a failure signal — business rejections arrive as HTTP **200** with the real code at `body.code`.
- **Do not assume a venue has an order-not-found *code*.** KuCoin reports it as its generic parameter-error code `100001` plus the message key `error.getOrder.orderNotExist`, so the map matches the message ahead of the table for that one key. Tabling the code would swallow real rejections, since `11` §6 treats a not-found cancel as "already gone". The testnet `error-taxonomy` check is what caught it, on the first credentialed run — a reason to keep that check's live probe.
- Size `rate_limit_weight_per_minute` so **both** lanes land under the venue's real caps, not just the order lane (Bybit 6000 @ 10 %, OKX 1200 @ 50 %, Bitget 1700 @ 35 %, KuCoin 3600 @ 33 %); the testnet `rate-limiter` check is what catches an off-by-a-hair general lane.
- **Check whether the venue's quoted price is per *prefixed* unit before folding a symbol prefix into `contractSize`.** Binance/Bybit/Bitget fold it; KuCoin must not, because there the prefix is already inside both the price and `multiplier`, and folding again under-sizes 1000× (task 0460, probed live). The same question is now open against the three siblings — see SUGGESTIONS.
- Deviations recorded at 0460, all deliberate: `shared/reconnect.ts` needed **no** `connect(): Promise<Endpoint>` hook (the KuCoin SDK owns the bullet-token handshake internally and emits the same events as its siblings), contradicting the 0460 task file's implementation note; the testnet summary's `network` widened from the literal `'testnet'` to `'testnet' | 'live-readonly'`; and KuCoin's tier reads `KUCOIN_API_*` + `KUCOIN_LIVE_READONLY=1` rather than `<VENUE>_TESTNET_*`, since there is no KuCoin testnet to name.
- `clientOid` ceilings are the thing to check first on a new venue: KuCoin's 40 chars clears the core's 36 (bare length guard), Bitget's 32 does not, OKX needs a real escape codec. A venue that demanded UUIDs would need a **crash-safe** id map, not a submit-time in-memory one (`11` §4).

### Env / tooling gotchas

- Migrations are hand-authored (drizzle-kit needs a TTY); its bundled `@esbuild-kit/*` advisories → revisit at 0530.
- `test:integration` + e2e need Docker Postgres, opt-in, outside `verify`; host port 5432 is often occupied — use an alt port.
- Node CLI entries need `scripts/register-ts.mjs` + `--experimental-transform-types`.
- Never actually ran: `crash-matrix.e2e.test.ts` DoD #9 (kill switch survives crash) typechecks only; Bybit testnet DoD step 3 never ran with real creds (credential-free skip path only). Binance/OKX/Bitget testnet tiers have all run credentialed 8/8.

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
| 0440 | adapter-bitget | done | |
| 0450 | adapter-gateio | done | skipped by decision — venue dropped, no adapter |
| 0460 | adapter-kucoin | done | read-only live tier (no sandbox exists); order path never venue-verified |
| 0470 | live-tier-harness | done | Scope **widened by the user**: venue-generic, ran live on all five venues, not Binance-only. Deviations: no Postgres/engine boot (adapter-level composition — that is 0480); `TestnetNetwork` += `'prod'`. Three suites (`self-test`/`fill-test`/`funding-test`) all pass on all five, except `funding-test` on OKX (needs a 4 h-aligned boundary). Findings: `docs/live-notes.md`. |
| 0480 | live-verification-binance | todo | |
| 0490 | s6-shadow | todo | |
| 0500 | s6-canary | todo | |
| 0510 | docker-fleet-packaging | todo | |
| 0520 | fleet-config-and-runbook | todo | |
| 0530 | ci-pipeline | todo | |
