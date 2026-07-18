# 0150 — Cost model (economic gate)

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0110, 0130
**Spec references:** `12_strategy_runtime_and_intent_lifecycle.md` §4 (Cost model); `00_globals.md` §1.1 (NET_PNL), §G-L/§G-S/§G-D (profit conditions), §11-R10; strategy files `01`–`07` §4 (profit conditions)

## Objective
The economic gate evaluated before committing an intent: each strategy family's profit condition computed with live cost inputs (fees from the exchange profile, threshold, funding magnitude), advisory at selection but **binding** on structurally-uneconomic configs — a configuration whose funding leg cannot cover fees is rejected at load, not discovered live.

## Context for the agent
Formulas are owned by the strategy files' §4 — reference their shapes, do not invent: Group L `|F| > |DELTA_PNL| + FEES`; S3a `DELTA_PNL > |F| + FEES` (TP path viable iff `|F| × (tpMult − 1) > taker + maker`); S4.x TP path `takeProfitPct > entry fee + exit fee`; S6 `MAIN_DELTA > |PRE_FUNDING_DELTA| + |FUNDING_PRE| + FEES`. The structural check at load: e.g. Group-L threshold −0.1 with 0.10% round-trip fees leaves no room (R10) — reject with a clear message. Fee class per fill (taker/maker) comes from the profile (`09` §4).

## Scope
- In scope:
  - `src/core/runtime/cost-model.ts`: per-exit-path fee computation helpers (taker/maker per strategy §4 tables) and per-family profit-condition evaluators keyed by strategy id.
  - Structural-config check invoked from the config pipeline (0110 hook): strategy + profile combination that is uneconomic at the configured threshold → load-time error naming the arithmetic.
  - Selection-time advisory evaluation wired into the finder→intent path (result recorded on the intent for analytics; does not block unless structurally impossible).
  - Unit tests reproducing each strategy file's §4 arithmetic examples (e.g. S3a at `|F|`=0.4, tpMult 1.5, fees 0.05/0.02 → TP path ≈ +0.13%).
- Out of scope: realized P&L decomposition from fills (0390 — that is accounting; this is ex-ante), slippage modeling beyond the specs' stated assumptions.

## Implementation notes
Keep evaluators pure and unit-driven: inputs `{F, fees, params}`, outputs a typed breakdown `{deltaTerm, fundingTerm, feeTerm, passes}`. Percent units throughout (`00_globals` §1.2) — resist converting to fractions internally; the specs' formulas are written in percent and tests should read like the spec.

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit tests reproduce the worked examples: S1 break-even drop tolerance 0.30% at threshold −0.4 (`01` §4); S3a `|F| > 0.14` viability bound (`04` §4); S4.1a `takeProfitPct > 0.04` (`05` §4); S6 inequality shape (`07` §4).
3. Config-load test: Group-L strategy with threshold −0.1 and default fees → load-time rejection citing R10; threshold −0.4 → loads.
