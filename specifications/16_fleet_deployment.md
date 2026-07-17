# Fleet Deployment

**Document:** `16_fleet_deployment.md` · includes `00_globals.md` by reference
**Covers:** the isolated-instance model, sub-accounts, the 5×6 fleet, Docker packaging, and one-strategy-per-container.

**Conclusion first.** The unit of deployment is **one instance = one strategy × one exchange × one sub-account × one database**. Running 5 strategies on 6 exchanges is **30 isolated instances**, each a container from the *same image* with a different config + secrets. Isolation is the safety model: a fault, a bad config, or a kill-switch flatten affects exactly one sub-account. This falls straight out of the co-run guard (`00_globals.md` §9.1 — one strategy per container) and the per-instance persistence model (`14`).

---

## 1. The instance model

| Dimension | Bound to one value per instance |
|---|---|
| Exchange | one of the six (`10` §1) |
| Strategy | one of `01`–`07` |
| Sub-account | dedicated API key/secret (`09` §2) |
| Database | one Postgres DB (`14`) |
| Config | one strategy YAML + the exchange profile (`09`) |
| Rate-limit budget | the sub-account's own budget (`10` §6) |

**Why isolation (binding rationale):**
- **Co-run guard** already forbids conflicting strategies in one container (`00_globals.md` §9.1): S3a (short) alongside any long strategy would offset inside the same funding window. One strategy per container removes the whole class.
- **Blast radius:** kill-switch `flatten` (`13` §2) closes only that sub-account; a crash recovers only that DB (`14`).
- **Rate limits & margin** are per sub-account, so instances never contend (`10` §6).
- **Attribution** is clean: every trade maps to exactly one (exchange, strategy, sub-account) tuple for analytics (`15`).

---

## 2. The 5×7 fleet

```
             Binance  Bybit  OKX  Bitget  Gate.io  KuCoin
strategy_1      ▪       ▪      ▪      ▪       ▪        ▪
strategy_1_ws   ▪       ▪      ▪      ▪       ▪        ▪
strategy_2      ▪       ▪      ▪      ▪       ▪        ▪
strategy_3a     ▪       ▪      ▪      ▪       ▪        ▪
strategy_4_1a   ▪       ▪      ▪      ▪       ▪        ▪
   ...
```

Any subset of the strategy set × the six venues; the illustration is 5×7 = **35 containers**. Each cell is an independent process with its own sub-account, config, DB, and lifecycle. Adding a strategy or a venue adds a row/column of containers — **no code change**, just config + secrets (the adapter and strategy already exist).

**Per-exchange deltas** (`00_globals.md` §6 — e.g. OKX `fundingFeeTimeoutSeconds = 45`, OKX `leverage = 4` on S1, OKX-only WS-order REST fallback) are applied per instance from the exchange profile (`09` §4), so the same strategy behaves correctly on every venue without branching.

---

## 3. Docker packaging

- **One image** for the whole fleet (the engine binary). Instance identity and behavior come entirely from environment + mounted config (`09`), never from the image.
- **One container per instance.** `docker compose` (or the orchestrator of choice) enumerates the fleet; each service sets `EXCHANGE`, `STRATEGY`, `SUBACCOUNT`, its secrets, and `DATABASE_URL`.
- **Fail-loud at boot** (`09` §5, `10` §4): bad config/instrument/auth aborts that container immediately; the orchestrator restart policy surfaces it. A broken instance never limps.
- **Stateless container, stateful DB:** all durable state is in Postgres (`14`); a container can be recreated and will recover from its DB + venue ground truth.

```yaml
# compose sketch — one service per instance, same image
services:
  s1ws-binance:
    image: funding-engine:latest
    env_file: [ env/s1ws-binance.env ]
    volumes: [ ./config:/app/config:ro ]
  s3a-okx:
    image: funding-engine:latest
    env_file: [ env/s3a-okx.env ]
    volumes: [ ./config:/app/config:ro ]
  # ... 30 total
```

---

## 4. Operating the fleet

- **Kill switch is per instance** (`13` §2), bootstrapped from that instance's `.env` and toggleable operationally; there is also a fleet-wide "pause all" implemented simply as toggling every instance (no shared runtime coupling).
- **Observability:** each instance logs structured JSON (Pino) bound with `{ exchange, strategy, subaccount, configHash }`; logs and the per-instance DBs feed the fleet rollup (`15` §5).
- **Config changes** are a redeploy of the affected instance(s) — immutable config per run (`09` §7) keeps every trade attributable to an exact revision.
- **Scaling:** horizontal by construction — more cells = more containers. No instance-to-instance runtime dependency exists, so there is no coordination layer to scale.

---

## 5. What deployment deliberately does *not* add

No shared message bus, no cross-instance scheduler, no service mesh, no central order router. The isolation model makes each instance a self-contained, recoverable unit — which is the simplest thing that satisfies the co-run guard, the per-sub-account rate/margin limits, and the blast-radius requirement. KISS at the deployment layer mirrors KISS in the core.
