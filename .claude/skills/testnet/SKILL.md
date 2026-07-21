---
name: testnet
description: >
  Run `npm run test:testnet` (task 0260) — the venue testnet verification tier — and
  interpret its JSON summary. Triggers on "/testnet", "run the testnet tier", "binance
  testnet check".
---

`src/testnet/` drives the real Binance USD-M futures testnet through the same
`ExchangeAdapter` the engine trades against, running the full `17_testing.md` §3
checklist as one command with a machine-readable pass/fail/skip summary. It is the
third verification layer (after unit and fixture/sim integration) — the template every
other venue's testnet tier (0420–0460) copies.

## Usage

```
npm run test:testnet -- --venue binance [--out PATH] [--json]
```

- No `BINANCE_TESTNET_API_KEY`/`_SECRET` in env → every check reports `skip: no
  credentials`, summary still written, **exit 0**. Never a red build on a missing key.
- With credentials → checks run serially (they share account state), writing
  `test/testnet/binance/summary.json` by default; `--out` overrides the path; `--json`
  also prints the machine-readable summary to stdout.
- Exit code is `1` iff `summary.failed > 0` — skips never fail the run.

## Interpreting the JSON summary

```
{ venue, network, toolVersion, startedAtMs, durationMs,
  total, passed, failed, skipped, results: [{ name, specRef, status, reason?, durationMs, detail? }] }
```

- `status: 'skip'` is an **expected, documented** outcome on testnet (no credentials,
  unfunded account, a check the venue's testnet genuinely can't exercise — see
  `docs/testnet-notes.md`). Read `reason` before treating a skip as a problem.
- `status: 'fail'` is the only thing that should block a merge. Read `reason` (the
  thrown error's message) and `detail` for context; cross-reference `specRef` against
  `docs/specs/17_testing.md` §3 to see which behavior broke.
- `results` order matches the registry (`src/testnet/binance/registry.ts`):
  `markets` → `rate-limiter` → `deltas` → `account-setup` → `order-path` → `streams` →
  `error-taxonomy` → `assert-flat`. `assert-flat` runs last regardless of earlier
  outcomes, so the account always ends the run flat and orderless.

## Rules

- **Testnet only.** Never point `BINANCE_TESTNET_API_KEY`/`_SECRET` at a prod account.
- Every credentialed, resting-order-producing check registers a cleanup
  (`ctx.onCleanup`) that runs in `finally` — a mid-check throw still cancels the order.
  `assert-flat` is the final backstop: it cancels any leftover open orders and flattens
  any leftover position before asserting the account is flat + orderless.
- Fund-dependent checks self-check the testnet balance first and skip-with-reason on an
  unfunded account rather than failing.
