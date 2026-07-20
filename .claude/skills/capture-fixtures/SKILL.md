---
name: capture-fixtures
description: >
  Wrap `npm run capture` (task 0250) to record real Binance venue responses into
  committed fixtures under `test/fixtures/binance/`, deterministically scrubbed so
  they stay stable and safe to commit. Triggers on "/capture-fixtures", "recapture
  binance fixtures", "regenerate the markets fixtures".
---

`src/capture/capture-binance.ts` drives the **real** ccxt/native Binance clients (never
a fake), collects raw payloads exactly as the adapter receives them, scrubs them
in-memory, and writes deterministic fixtures. Use it when a venue changes a payload
shape, a new capturable market appears, or a fixture set goes stale.

## Usage

```
npm run capture -- --venue binance --set markets     [--out DIR]
npm run capture -- --venue binance --set public-ws    [--count N] [--window-ms N] [--out DIR]
npm run capture -- --venue binance --set private-ws   [--window-ms N] [--out DIR]
npm run capture -- --venue binance --set orders       [--out DIR]
```

- `markets` / `public-ws` are **credential-free** (public REST/WS) — safe to run anytime.
- `private-ws` / `orders` are **testnet-only** and read `BINANCE_TESTNET_API_KEY` /
  `BINANCE_TESTNET_API_SECRET` from env; absent either, the command fails loud
  (non-zero exit), never a silent no-op. `orders` places **one** far-from-market limit
  order and immediately cancels it — never anything that can fill.

## Interpreting a fixture set

Each set directory carries a `manifest.json`: `{ set, venue, network, capturedAtMs,
toolVersion, source, count, synthetic }`.

- `synthetic` lists sibling fixture stems in the same directory that are **hand-authored**,
  not captured — no healthy live/testnet venue emits them (spot/inverse/dated/delisted
  markets from other ccxt classes, funding-4h because ccxt doesn't populate the interval
  today, deliberately malformed anomaly rows, multiplier/collision edge cases). Never
  overwrite these with a capture run; they are meant to stay authored JSON.
- `capturedAtMs` + `toolVersion` are what tell you a fixture is stale — a schema change in
  `src/capture/scrub.ts` bumps `CAPTURE_TOOL_VERSION`; an old `capturedAtMs` next to a
  known venue payload change means it's time to recapture.
- `markets` writes pretty 2-space `.json` per symbol (reviewable in a diff); `public-ws`/
  `private-ws` write one compact JSON object per line to `frames.jsonl`.

## Rules

- **Never commit secrets.** The scrubber drops any field whose name matches
  `key|secret|signature|passphrase|password` and redacts any string value that is
  secret-shaped (a long base62/base64-ish token, e.g. a listen key echoed back as
  `streamName`) regardless of field name. After capturing, sanity-check with:
  `grep -rIE 'api|secret|[A-Za-z0-9+/]{40,}={0,2}' test/fixtures/binance/` — expect no hits.
- **Testnet only** for `private-ws`/`orders` — never point this at a prod account.
- **Byte-stability**: re-running `markets` twice produces identical fixture bytes (only
  `manifest.json`'s `capturedAtMs` differs) — market metadata is static reference data, so
  a diff there means something upstream actually changed. `public-ws`/`private-ws`/`orders`
  capture live, time-varying venue activity, so re-running them will *not* reproduce
  byte-identical output — that's expected, not a bug.
