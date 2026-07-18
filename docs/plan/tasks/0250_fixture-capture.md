# 0250 — Fixture capture tooling

**Phase:** 3 — Binance adapter
**Depends on:** 0210, 0220
**Spec references:** `0000_agentic-development-environment.md` §5 (fixture capture tooling); `17_testing.md` §3 (integration via fixtures/testnet)

## Objective
A script that records real venue responses — REST payloads and WS message streams — into committed fixtures, so adapter tests stay realistic without staying online. The hand-captured fixtures from 0190–0220 are regenerated through this tool, proving it round-trips.

## Context for the agent
This is agent-environment tooling (spec 0000 §5): when a venue changes a payload or a new venue lands (0420–0460), the agent re-captures instead of hand-editing JSON. Capture must **redact secrets** (keys, listen keys, account ids) and normalize volatile fields (timestamps, ids) behind a documented, deterministic scrubbing step so fixtures are stable and safe to commit.

## Scope
- In scope:
  - `scripts/capture-fixtures.ts` (`npm run capture -- --venue binance --set markets|public-ws|private-ws|orders`): runs the relevant adapter paths (public sets need no keys; private/order sets are env-gated and use testnet by default), records raw payloads, scrubs, writes to `test/fixtures/binance/<set>/`.
  - Scrubber: secret redaction, timestamp/id normalization with a mapping file so related messages stay consistent, stable JSON formatting.
  - Fixture manifest per set (what was captured, when, from where — testnet vs prod, tool version).
  - Migrate existing 0190–0220 fixture-driven tests to load from the tool's output layout; regenerate public fixtures with the tool.
  - `/capture-fixtures` skill in `.claude/skills/` documenting usage + interpretation (extends 0180's set).
- Out of scope: fixtures for other venues (their tasks run this tool), scenario files (0160 — those are synthetic by design), live production order capture (testnet/public only until 0470).

## Implementation notes
WS capture: subscribe, record for a bounded window or message count, then close — deterministic termination. Keep raw-vs-scrubbed as two steps with the raw never written to disk (redact in-memory) to avoid committing a secret by accident. The manifest is what lets a future agent judge staleness.

## Verification (definition of done)
1. `npm run verify` — green with migrated fixture paths.
2. `npm run capture -- --venue binance --set markets` (no credentials) produces fixtures that byte-match a re-run after scrubbing (run twice, diff empty), and the 0190 tests pass against them.
3. Grep captured fixture dir for key material patterns (`api`, `secret`, base64-ish listen keys) — no hits.
4. Env-gated: private-ws capture against testnet produces a parseable set; suite/step skips without credentials.
