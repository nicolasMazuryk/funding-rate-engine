---
name: live-tier
description: >
  Run `npm run test:live` (task 0470) — the fourth verification layer: **real orders on a
  production venue with real money**, bounded by compiled-in notional caps — and interpret
  its verdict. Triggers on "/live-tier", "run the live tier", "live self-test on bybit",
  "funding-test on all venues".
---

`src/live/` drives the five **production** venues (binance, bybit, okx, bitget, kucoin)
through the same `ExchangeAdapter` the engine trades against. It is the only tier that can
show a real fill, a real fee, a real precision reject, and a real funding settlement — the
things sim, testnet and e2e structurally cannot. Every run spends real money, capped at
**25 USD per order / 50 USD total exposure**.

Observed venue behavior lives in `docs/live-notes.md` — **read it before running anything
here**; every quirk in it cost a real order to find.

## Usage

```
npm run test:live -- --subaccount <strategy-id> [--venue <v> | --all-venues]
                     [--suite <self-test|fill-test|funding-test>] [--parallel]
                     [--out PATH] [--json]
```

- `--subaccount` is **required, no default** (`s1`, `s1-ws`, `s2`, `s3a`, `s4-1a`, `s4-2a`,
  `s6` — the ids in `config/subaccounts.yaml`). The failure this tier most needs to prevent
  is trading the wrong account, so every run names the one it may touch.
- `--suite` defaults to `self-test`. Venues run **serially** unless `--parallel`.
- No `config/subaccounts.secrets.yaml` (gitignored) → every check reports
  `skip: no live credentials`, the verdict is still written, **exit 0**. A machine without
  live keys is never a red build.
- Verdict artifact: `test/live/<venue>/<suite>.json` (gitignored), trace alongside it as
  `<suite>.trace.jsonl`. `--out` overrides the path, `--json` also prints it to stdout.

## The three suites

| Suite | Places | Fills? | Fee bound | Wall-clock |
|---|---|---|---|---|
| `self-test` | preflight → order-lifecycle → cap-rejection → assert-flat | no (rests 3 % away, cancels) | 0.02 USD | seconds |
| `fill-test` | preflight → fill-entry → position-tracking → reduce-only-close → assert-flat | **yes**, marketable limit | 0.06 USD | seconds |
| `funding-test` | `fill-test` + funding-window (first) and funding-settlement | **yes**, held across a real settlement | 0.12 USD | up to an hour, mostly idle |

`funding-test` targets the next boundary on **that venue's own shortest funding cadence**.
To run all five against one shared settlement, start before a **4 h-aligned hour** (`00:00`,
`04:00`, … UTC) and pass `--parallel`; OKX lists no 1 h symbols, so at any other hour it
idles until its own next 4 h boundary. The window needs ~9 minutes of preparation lead —
starting after `HH:51` targets the following hour.

## Interpreting the verdict

The verdict is a superset of the testnet `TestnetSummary`:

```
{ venue, suite, network: 'prod', subAccount, caps, exposureUsd, capRejections,
  feesUsd, feeBoundUsd, teardown, tracePath,
  total, passed, failed, skipped, results: [{ name, specRef, status, reason?, ... }] }
```

Exit `1` iff any check **failed**, *or* `teardown.verifiedFlat` is not `true`, *or*
`feesUsd > feeBoundUsd`. An all-skip run is `0`; a run with zero checks is `1`.

- **`teardown.verifiedFlat` is the first thing to read** — an all-pass run that could not
  prove the account flat is a *failed* run. Money left on a venue outranks every check.
  When it is false the CLI prints a `MANUAL INTERVENTION REQUIRED` line naming the venue,
  sub-account label and id: go look at that account by hand.
- `feesUsd` over the bound means the tier did something other than what it thinks it did
  (an unintended fill, an escalated cross), not merely that it was expensive.
- `capRejections` is expected to be non-empty on `self-test` (the `cap-rejection` check
  deliberately submits 3× over cap) and empty everywhere else. A rejection you did not
  intend means a check tried to place an order it should not have.
- `subAccount` carries the registry row and **never** its credentials — a verdict is safe
  to paste.
- A `fail` reason quotes the `OrderUpdate{REJECTED|FAILED}` off the bus (submits are
  fire-and-forget, so the reason is never in the ack). Cross-reference `specRef` and
  `docs/live-notes.md` before assuming a code bug.

## Hard rules

- **Never raise the caps.** `LIVE_MAX_ORDER_NOTIONAL_USD = 25` and
  `LIVE_MAX_TOTAL_NOTIONAL_USD = 50` are compiled-in constants, deliberately unreachable
  from YAML, env or CLI. `resolveCaps()` clamps **down only**. If a suite does not fit
  under the cap, change the suite.
- **Never bypass the cap wrapper.** Every live context hands out a `CappedAdapter`; the raw
  adapter handle is never exposed. Do not construct one around `withNotionalCap`.
- **Never run without `--subaccount`**, and never point it at an account you have not read
  in `config/subaccounts.yaml`. Preflight refuses a sub-account whose balance is > 2×
  allocated, or that already holds positions or open orders — that refusal is the feature,
  not an obstacle to work around.
- **Never automate this tier.** No CI, no cron, no `verify`. It is an explicit, human-run,
  human-confirmed command; confirm with the user before a venue's first run of a suite.
- **Prove a teardown with an independent follow-up run**, never with the teardown's own
  report — a venue's order read can lag a submit and return a false flat (see the SIGINT
  drill in `docs/live-notes.md`).
- Secrets live only in gitignored `config/subaccounts.secrets.yaml`. Never echo it, never
  paste a key into a verdict, notes, or a commit.
