# 0300 — Strategy S1-WS + `funding_fee_event` exit kind

**Phase:** 4 — Strategies
**Depends on:** 0280, 0290
**Spec references:** `02_strategy_1_ws.md` (all sections); `00_globals.md` §G-L, §6 (WS-mandatory, REST fallback flag); `09_configuration.md` §6 (WS-mandatory guard)

## Objective
S1-WS: same §G-L selection and funding-collection bet as S1, but entry via the **WS order adapter** (mandatory — startup throws without one unless the profile enables REST fallback) and exit gated on confirmed funding accrual: gate opens (WS or REST) → SELL MARKET reduce-only (`exit_reason = funding_fee_event`); gate timeout → fallback exit (`funding_fee_timeout`).

## Context for the agent
First WS-mandatory strategy — the `09` §6 startup guard (0110) now gets a real consumer: booting `strategy_1_ws` on a profile without WS order capability and without `ws_order_rest_fallback` must throw at startup. Both exit paths are taker, reduce-only. The reduce-only close must survive a WS order rejection via immediate REST fallback (binding assumption carried in `02` §3 — the exit leg's fallback applies regardless of the entry-path flag; protecting an open position outranks the fallback-flag gate). Timeout is the delta-exposure cap: proposed 10 s, venue delta may override (e.g. 45 s) via exchange profile.

## Scope
- In scope:
  - `src/core/strategies/strategy-1-ws.ts` (selection identical to S1 — share the §G-L selection helper, don't copy).
  - `src/core/intent/exit-policies/funding-fee-event.ts`: arms the funding gate (0290) on entry fill; gate open → exit with `funding_fee_event`; timeout → exit with `funding_fee_timeout`.
  - Entry path over the WS order adapter (0230) with the startup guard verified end-to-end.
  - Exit-leg protection: WS reject on the reduce-only close → immediate REST fallback (documented deviation-by-design from the entry flag, per `02` §3 assumptions).
  - Tests: sim scenarios — event exit (assert exit fires only after gate opens, never before), REST-poll-sourced exit, timeout exit at exactly `T_settle + timeout`, WS-entry-unavailable startup throw, mismatched-cycle event does not exit early; e2e happy path with trade record `exit_reason = funding_fee_event`; golden replay.
- Out of scope: retracement logic (0310), realized `|DELTA_PNL|/|F|` analytics (0410).

## Implementation notes
The handler holds *through* the start of the drop by design (`02` §0) — no price-based exits here; resist adding an SL. Reuse the S1 module structure; the only deltas are entry transport and exit policy — if you find yourself copying selection code, extract the §G-L helper instead.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green, new scenarios included.
2. Scenario asserts ordering: entry fill < `T_settle` < gate open < exit submit on the virtual clock timeline (trace-checked).
3. Startup guard: e2e boot with a WS-less sim profile and no fallback flag → process/composition throws citing the WS-mandatory rule; with `ws_order_rest_fallback: true` → boots.
4. Timeout scenario: no funding event → exit at `T_settle + 10 s`, `exit_reason = funding_fee_timeout`.
