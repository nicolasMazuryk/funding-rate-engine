# Configuration — Env, YAML, Validation, Startup

**Document:** `09_configuration.md` · includes `00_globals.md` by reference (parameter registry §8.2, bounds §9.1, unit guards §9.2)
**Principle:** *fail loud, fail early* — every config value is validated with **Zod** at startup; any violation aborts the process **before any exchange call**.

**Conclusion first.** Two config sources only: **`.env`** for secrets and environment wiring, **YAML** for everything else. One canonical schema drives validation. Strategy parameters are **not** redefined here — their names, units, defaults, and bounds are owned by `00_globals.md` §8.2 / §9. This doc specifies the *shape*, *loading*, and *validation* of an instance's config, and how per-exchange deltas (`00_globals.md` §6) are applied.

---

## 1. Config sources & precedence

| Source | Contents | Committed? |
|---|---|---|
| `.env` | API key/secret/passphrase per exchange sub-account, DB URL, log level, instance identity (`EXCHANGE`, `STRATEGY`, `SUBACCOUNT`), `KILL_SWITCH` bootstrap state. | **No** (secrets) |
| `config/<strategy>-<exchange>.yaml` | Strategy parameters (per `00_globals.md` §8.2), risk limits, sizing, timeouts, symbol allow/deny, feature flags. | Yes |
| `config/exchanges.yaml` | Per-venue static profile: fees, rate limits, stagger, WS endpoints, per-exchange deltas (§6 of globals). | Yes |

**Precedence:** `.env` (identity + secrets) selects which YAML files load; YAML provides behavior. No env var overrides a strategy parameter — parameters live in YAML only, so config is reviewable in version control. One instance loads exactly one strategy YAML and one exchange profile (see `16_fleet_deployment.md`).

---

## 2. `.env` (secrets & wiring)

```
# identity — selects config files and sub-account
EXCHANGE=binance
STRATEGY=strategy_1_ws
SUBACCOUNT=fund-s1ws-binance

# secrets (per sub-account)
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
# OKX also needs BINANCE_API_PASSPHRASE-style passphrase where applicable

# infra
DATABASE_URL=postgres://user:pass@host:5432/trading_s1ws_binance
LOG_LEVEL=info
KILL_SWITCH=off            # off | paused | flatten  (bootstrap; 00_globals §7.1)
```

Secrets are read once at startup, wrapped, and never logged (Pino redaction on `*_SECRET`, `*_KEY`, `*_PASSPHRASE`).

---

## 3. YAML — strategy instance config (shape)

One file per instance. Parameter **keys, units, and bounds are canonical** (`00_globals.md` §8.2/§9.1) — this is only the container shape.

```yaml
instance:
  exchange: binance
  strategy: strategy_1_ws
  enabled: true                 # 00_globals §4 — false skips the strategy entirely

sizing:
  amount_usd: 20                # fixed sizing for now (brief); 00_globals §4
  leverage: 5                   # per-exchange delta may override (OKX=4 on S1)

strategy_params:                # validated against the strategy's slice of §8.2
  negative_funding_threshold_percent: -0.4
  entry_offset_seconds: 3
  funding_fee_timeout_seconds: 10   # OKX profile overrides to 45 (§6)
  # ... only the keys this strategy consumes; unknown keys = hard error

risk:                           # see 13_risk_and_failure_modes.md
  max_concurrent_intents: 1
  max_notional_usd: 20
  max_daily_loss_usd: 100
  breaker_error_threshold: 5

symbols:
  mode: auto                    # auto = all perp-USDT passing filters (10 §3)
  deny: [ ]                     # optional explicit exclusions
```

**Binding rules**
- **Unknown key = error, not ignored** (`00_globals.md` §9.2; also enforces the S3a/S2 `stopLossPercent`-vs-`slMultiplier` foot-gun — the wrong key on a strategy is rejected).
- **Unit guards** run as part of Zod refinement (`take_profit_pct < 0.05` → `unit_suspect_fraction`, `retracement_pct > 1.0` → error, etc., per `00_globals.md` §9.1/§9.2).
- **Canonical schema is single-source.** The live (camelCase) schema is **generated from one schema definition** (`00_globals.md` §9.2). Hand-writing a config in the wrong shape is rejected.

---

## 4. YAML — exchange profile (`exchanges.yaml`)

Static, venue-level facts. Consumed by the adapter (`10`) and merged into effective config as **per-exchange deltas** (`00_globals.md` §6).

```yaml
binance:
  taker_fee_pct: 0.05
  maker_fee_pct: 0.02
  submission_stagger_ms: 100
  rate_limit_reserve_pct: 10        # 10% reserved for order submit/cancel (§6)
  ws:
    public_url: ...
    private_url: ...
  deltas: { }                       # none

okx:
  taker_fee_pct: 0.05
  maker_fee_pct: 0.02
  submission_stagger_ms: 100
  ws: { ... }
  deltas:
    funding_fee_timeout_seconds: 45 # 00_globals §6
    leverage_strategy_1: 4          # 00_globals §6
    ws_order_rest_fallback: true    # OKX-only REST fallback on WS_TIMEOUT (§6)
```

Deltas are applied **after** base validation and **re-validated** against the same bounds, so a delta can never push a value out of range silently.

---

## 5. Loading & validation pipeline (startup, fail-loud)

```
1. load .env (dotenv)            → EnvSchema.parse()      → identity + secrets
2. load strategy YAML            → StrategyConfigSchema.parse()
3. load exchanges.yaml[exchange] → ExchangeProfileSchema.parse()
4. merge per-exchange deltas     → re-validate bounds (00_globals §9.1)
5. cross-checks (§6)             → EffectiveConfig (frozen)
6. instrument validation         → 10 §4 (needs a live client; still startup)
   any failure at any step  →  log the exact key + reason  →  process.exit(1)
```

`EffectiveConfig` is immutable and passed by value into the composition root (`main.ts`). Nothing reads config from disk after startup.

---

## 6. Cross-cutting validations (beyond single-field bounds)

| Check | Rule | Source |
|---|---|---|
| Co-run guard | reject `strategy_3a` alongside any LONG strategy; one strategy per container anyway | `00_globals.md` §9.1 |
| WS-mandatory guard | `strategy_1_ws` / `strategy_2` / `strategy_6` require a WS order adapter → **throw at startup** if the venue/profile can't provide one (OKX REST fallback is the only exception) | `00_globals.md` §6 |
| Sizing feasibility hint | `amount_usd` ≥ venue min-notional for the cheapest tradable symbol (soft warn; hard per-symbol check at preflight, `12`) | `00_globals.md` §4 |
| Deadline vs timeout sanity | `deadline_seconds` ≥ `funding_fee_timeout_seconds` where both apply (S2/S6) | bounds §9.1 |
| Secret presence | required keys for the selected exchange are present and non-empty | this doc |

---

## 7. Config change management

- Config is **version-controlled** and reviewed; a change is a redeploy of the instance (immutable config per run — no hot reload). This keeps every trade attributable to an exact config revision (recorded in the WAL header, `14`).
- The `KILL_SWITCH` bootstrap value in `.env` sets the initial state; runtime transitions are operational (`13`) and persisted, not config.
- The config revision hash is logged at startup and stamped on every persisted intent for audit (`15`).

---

## 8. Single-schema guarantee

This document governs the **live (camelCase)** schema, generated from the one canonical schema definition (`00_globals.md` §9.2). There is only one runtime consumer of strategy parameters, so a parameter has exactly one meaning everywhere it is used — the property the unit-guard regime exists to protect.
