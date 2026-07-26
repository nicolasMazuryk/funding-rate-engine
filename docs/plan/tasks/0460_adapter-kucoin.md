# 0460 — KuCoin adapter

**Phase:** 6 — Remaining venues
**Depends on:** 0260
**Spec references:** `10_exchange_adapters_and_market_data.md` (all); `11_execution_and_account_state.md`; `17_testing.md` §3

## Objective
The complete KuCoin (futures) adapter behind the one interface, following the Binance pattern — clients, error mapping, public/private WS, WS-first orders, fixtures, testnet tier where usable — zero core changes. With this task, all five venues are live behind one contract (Gate.io/0450 was dropped — STATUS 0450).

## Context for the agent
Structure and process identical to 0420 (the template task — read it first). KuCoin particulars to investigate and record: native lib per canonical list (`kucoin-api`; ROADMAP A5 applies), passphrase auth, KuCoin Futures' dynamic WS endpoint discovery (bullet-token handshake before connecting — the reconnect state machine from 0210 must accommodate re-fetching the endpoint), contract multipliers (lot sizing in contracts — 0120 path), sandbox availability and fidelity (KuCoin's futures sandbox has historically been limited; assess per checklist item and record), WS order capability (the profile must state it honestly — it gates which strategies can run on the venue, `09` §6).

## Scope
- In scope:
  - `src/adapters/exchanges/kucoin/` mirroring the Binance layout.
  - Fixtures via `npm run capture -- --venue kucoin`; completed `exchanges.yaml` profile.
  - Fixture-driven unit tests incl. multiplier sizing; `npm run test:testnet -- --venue kucoin` with skip-with-reason for unprovable items.
  - Close-out check for the phase: `src/adapters/CLAUDE.md` venue-quirk table has a column per venue; `exchanges.yaml` has all five complete profiles.
- Out of scope: core changes (`git diff src/core/` empty), live-money runs.

## Implementation notes
Follow the established venue-task checklist (0420). The token-handshake connection flow was expected to stress the shared reconnect utility, with a venue-agnostic `connect(): Promise<Endpoint>` hook as the remedy. **It does not**: the native SDK performs the bullet-token handshake internally and keys subscriptions by `wsKey`, emitting the same `open`/`reconnect`/`reconnected`/`close`/`update` events as its three sibling SDKs, so `src/adapters/shared/reconnect.ts` is reused verbatim and no hook was added (deviation recorded in STATUS).

## Verification (definition of done)
1. `npm run verify` — green offline.
2. Captured fixtures committed; no secret material (grep).
3. There are **no sandbox credentials** — KuCoin decommissioned its futures sandbox — so this venue's tier is a **read-only** subset run against the live host, gated on `KUCOIN_API_KEY`/`_API_SECRET`/`_API_PASSPHRASE` plus an explicit `KUCOIN_LIVE_READONLY=1` opt-in: `npm run test:testnet -- --venue kucoin` → 6 checks pass/skip-with-reason, asserted flat (never auto-flattened) at exit; clean skip without credentials.
4. `git diff` clean under `src/core/`; all-five-profiles check passes; `docs/testnet-notes.md` updated.
