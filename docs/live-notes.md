# Live notes

Observed behavior of the **live tier** (`npm run test:live`, task 0470) against the five
production venues with real money. The sibling of `docs/testnet-notes.md`: that file records
what a *testnet* cannot show, this one records what only a **production** account does.

Every quirk below cost a real (capped) order to find. Read this before adding a live suite.

## `self-test` verdicts

Run: `npm run test:live -- --venue <v> --suite self-test --subaccount s6`, one venue at a
time, 25 USD per-order / 50 USD total caps.

| Venue | Verdict | Notes |
|---|---|---|
| binance | **4/4 pass**, REST-verified flat, 0 fees | after the `fetchOpenOrders` ack below |
| bybit | **4/4 pass**, REST-verified flat, 0 fees | no quirks — the only venue that worked first try |
| kucoin | **4/4 pass**, REST-verified flat, 0 fees | first real order ever placed on this venue from this repo; took two fixes |
| okx | **4/4 pass**, REST-verified flat, 0 fees | only after an orphan cross-margin position was closed by hand; see below |
| bitget | **4/4 pass**, REST-verified flat, 0 fees | only after the sub-account was upgraded Classic → UTA v3; see below |

No fills occurred: `order-lifecycle` rests a limit 3 % away and cancels it, so realized fees
were `0.0000 USD` on every venue. The `cap-rejection` check confirmed on every venue that a
3×-over-cap order is refused by the wrapper and **never reaches the venue**.

Both initial blocks were sub-account *state*, not code — and in both cases preflight refused
the account and placed no order, which is the behavior the check exists for.

## `fill-test` verdicts — the first real fills

Run: `npm run test:live -- --venue <v> --suite fill-test --subaccount s6`. A marketable limit
0.5 % through last, held for seconds, then closed reduce-only. All five **5/5 pass**,
REST-verified flat, every fee inside the 0.06 USD suite bound.

| Venue | Symbol | Qty | Fill px | Notional | Round-trip fee | Position seen via |
|---|---|---|---|---|---|---|
| binance | ADA | 31 | 0.1639 | 5.08 USD | 0.0051 USD | stream |
| bybit | ADA | 31 | 0.1641 | 5.09 USD | 0.0102 USD | stream |
| okx | SUI | 1 | 0.7137 | 0.71 USD | 0.0007 USD | stream |
| bitget | ADA | 31 | 0.1643 | 5.09 USD | 0.0102 USD | stream |
| kucoin | SUI | 1 | 0.7158 | 0.72 USD | 0.0009 USD | stream |

Two things held on **every** venue: the fill landed *better* than the marketable limit (the
book was tighter than the 0.5 % cross), and the position reached the engine's own
`createPositionTracker` off the **private stream** — the REST `reconcile()` fallback was never
needed, so all five `PositionUpdate` mappings are now observed against a real fill rather than
a fixture.

Three code defects surfaced, all in the **production adapters**, none in the harness:

- **binance + kucoin report no fee on a filled order.** Both `fapi/v1/order` and KuCoin's
  `/api/v1/orders` return a fill with the commission simply absent, so `15` §2 reconciliation
  had nothing to compare and the run's realized cost read as `0.0000 USD`. The money truth is
  on the fills endpoint on both (`fapi/v1/userTrades`, `/api/v1/fills`), so a *terminal* order
  with a missing fee now costs one extra read, summed by the shared
  `src/adapters/shared/order-fee.ts`. Bounded by construction: a resting order never triggers
  it, and a fills read that fails degrades to the old fee-less order rather than failing the
  fill-poll.
- **bitget reported no fill price and a negative fee.** ccxt's v3 order parse leaves `average`
  unset — a real fill read as blind (`ADA filled but reported no usable fill price`) — while
  the raw row carries `avgPrice`. The same row's ccxt `fee.cost` arrives **negative** for a
  charge although the raw `feeDetail` is positive, which would have *credited* the engine for
  trading. Fixed in `toOrder`: `avgPrice` fallback, and the fee travels as a magnitude (the
  port's `fee` is a positive cost on every venue). A genuine maker rebate is indistinguishable
  from a charge here — recorded in SUGGESTIONS.
- **okx refused the order before it left the process.** `clOrdId` is alphanumeric-only, so the
  escape codec doubles every hyphen: `live-fill-<ms>-entry-1` encodes to 35 characters against
  a 32 ceiling. The live checks now use short intent ids (`lf-<ms>`, `lc-<ms>`, 27 encoded).
  The check reported only "not accepted" until `checks/reject-reason.ts` started quoting the
  `OrderUpdate{REJECTED|FAILED}` the bus already carried — a fire-and-forget submit puts the
  reason on the bus, never in the ack.

`self-test` had proven none of these: it cancels before the book reaches it, so no venue ever
had to report a fill price or a fee.

## `funding-test` — settlement, the last thing only production can show

Run: `npm run test:live -- --all-venues --parallel --suite funding-test --subaccount s6`, started
any time before `HH:51` (the window needs nine minutes of preparation lead, else it targets the
following hour). Same capped marketable entry as `fill-test`, but the position is
**held across a real settlement** before the reduce-only close.

The naive shape — open a position and wait for whatever settlement comes next — holds real money
for up to a funding interval, which on the 8 h default is most of a working day *per venue*. The
`funding-window` check inverts it, and that inversion is what makes the suite runnable on demand:

1. target the next boundary on **this venue's own shortest cadence**, and treat every symbol whose
   grid contains that boundary as eligible, shortest cadence first.

   Both halves are load-bearing, and **OKX is why**: it lists 416 markets and *zero* on the 1 h
   grid (its cadences are 4 h and 8 h). A 1 h-only *eligibility* rule leaves it with no candidates;
   a 1 h-only *boundary* rule is worse, because at an hour like 17:00 — 1 h-aligned and nothing
   else — nothing on that venue settles at all, so the universe is empty. Both were observed live:
   the first pass happened to target 16:00, which is also 4 h- and 8 h-aligned, and looked fine.
   Taking the venue's own minimum cadence makes the target structurally non-empty everywhere.

   **Operationally: to run all five against one shared boundary, start before a 4 h-aligned hour**
   (`00:00`, `04:00`, `08:00`, `12:00`, `16:00`, `20:00` UTC). At any other hour OKX targets its
   own next 4 h boundary and idles until then;
2. at `T−6 min`, read predicted funding down that list and keep the ones paying a long —
   threshold `−0.01 %`, deliberately near zero, because the tier verifies that funding *arrives
   and is signed correctly*, not that it is profitable. The scan stops at 6 qualifying symbols or
   120 reads, whichever comes first, and says so;
3. size toward **20 USD**, not the venue minimum: funding is a fraction of notional, and a 5 USD
   position at −0.01 % credits half a micro-dollar, which a venue may round to zero and the check
   would then read as "never funded";
4. release the entry at `T−3 min`, and let it **escalate**: cross 2 %, and if that rests instead
   of filling, cancel, re-read last and cross 5 %. The suite cannot pick a liquid symbol — it
   trades whatever pays the most, and those spreads can swallow a 0.5 % cross whole (OKX's `BEAT`
   rested unfilled and the run lost its settlement). Paying the spread is the correct trade here:
   the run costs an hour of wall-clock and the position is capped at 20 USD. Two rungs is the
   ceiling, and the ceiling is the **cap** — a cancelled order's reservation is never released, so
   a third 20 USD attempt would breach the 50 USD total-exposure ceiling.

So the real-money exposure is minutes rather than hours, and all five venues share **one**
boundary — hence `--parallel`. Serially, five venues would need five settlements.

Two witnesses must agree, and that is the point of the suite:

- the private stream's **`FundingFeeAccrued`** — the hot-path signal the funding gate trades on
  (`00_globals.md` §6), and the *only* place a venue's funding mapping is ever exercised;
- **`fundingIncome()`** — the REST money truth, matched to the same settlement within 5 s
  (ROADMAP A1) and to the same signed amount.

The **sign** is cross-checked against the settled rate from `fundingHistory()`: the run only ever
holds a long, so a negative settled rate must arrive as a credit. A sign-flipped mapping is
otherwise invisible — it reads as a perfectly plausible payment.

Three mappings were documentation-only guesses before this suite existed: OKX's
`balance_and_position` delta, Bitget's balance-delta inference, and KuCoin's `position.settlement`
**sign** (`src/adapters/CLAUDE.md` quirk table).

**Binance's `fundingIncome` was a `NotImplemented` stub until this phase** — the funding gate's
REST safety net did not exist on the venue the engine boots against by default. It now reads
`fapi/v1/income` through ccxt's `fetchFundingHistory` (which pins `incomeType=FUNDING_FEE`),
signed positive-is-received, symbol- and range-filtered. All five venues now implement it.

| Venue | Verdict | Symbol | Rate | Notional | Funding received | Witness skew | Fees |
|---|---|---|---|---|---|---|---|
| binance | **7/7 pass** | DEXE | −0.111 % | 19.74 USD | +0.02183 USD | 282 ms | 0.0198 USD |
| bybit | **7/7 pass** | ERA | −0.027 % | 19.58 USD | +0.00291 USD | 0 ms | 0.0392 USD |
| bitget | **7/7 pass** | DEXE | −0.113 % | 19.63 USD | +0.02294 USD | 0 ms | 0.0393 USD |
| kucoin | **7/7 pass** | ERA | −0.059 % | 18.86 USD | +0.01088 USD | 0 ms | 0.0226 USD |
| okx | *pending a 4 h-aligned boundary* | — | — | — | — | — | — |

(2026-07-27 17:00Z settlement; every venue REST-verified flat, every fee inside the 0.12 USD
suite bound. A 16:00Z pass produced the same shape with different symbols.)

Observed funding path per venue, now all confirmed against a real settlement rather than inferred:

| Venue | Stream witness | REST witness |
|---|---|---|
| binance | WS `ACCOUNT_UPDATE` `FUNDING_FEE`, amount from the quote-asset balance delta | `fapi/v1/income` `incomeType=FUNDING_FEE` |
| bybit | WS `execution` `execType: Funding`, `execFee` negated | transaction-log `type=SETTLEMENT`, field `funding` |
| bitget | WS `account` balance delta | v3 financial records `MARGIN_SETTLE_FEE_USER_IN` (see below) |
| kucoin | WS `position.settlement` `fundingFee` — **sign confirmed**, previously taken on faith | `/api/v1/funding-history` |
| okx | WS `balance_and_position` `funding_fee` delta | bills `type=8` |

Three things this closed that nothing else could have:

- **Binance's `fundingIncome` was a `NotImplemented` stub.** The funding gate's REST safety net
  did not exist on the venue the engine boots against by default. It now reads `fapi/v1/income`
  through ccxt's `fetchFundingHistory` (which pins `incomeType=FUNDING_FEE`), signed
  positive-is-received. All five venues now implement it.
- **KuCoin's `position.settlement` sign** was documented as "unverified, taken as credit-positive".
  It is correct.
- **Bitget's `fundingIncome` returned nothing, ever** — see below. The most valuable find of the
  phase, and invisible to every earlier tier.

### Bitget — ccxt cannot read an isolated position's settlement

The first live run held a real 19.68 USD `DEXE` position across the 16:00Z settlement. The private
stream reported the credit; `fundingIncome()` returned nothing — and still nothing eight minutes
later over a two-hour window, so not lag. The row was on the venue the whole time:

```
{"type":"MARGIN_SETTLE_FEE_USER_IN","symbol":"DEXEUSDT","amount":"0",
 "positionAmount":"0.03354917","positionType":"isolated","ts":"1785168007703"}
```

ccxt's `fetchFundingHistory` hits the right v3 endpoint but keeps only rows typed
`CONTRACT_MAIN_SETTLE_FEE_USER_*` — an **isolated** position's funding is typed
`MARGIN_SETTLE_FEE_USER_*` — and it parses the `amount` field, which is `"0"` on those rows
because the credit lands in the *position's* margin and is carried on `positionAmount`. Every
order this engine places is isolated (`11` §1), so the read was dead on this venue, always.

The adapter now parses the records itself: `coin` + `category` scoped (omitting either answers
`400172`), matched on the shared `SETTLE_FEE_USER_` suffix so both margin modes map, magnitude
from `positionAmount` or `amount`, direction from the `_IN`/`_OUT` tail rather than from the
number. Verified against the settlement that had already happened, then again live at 17:00Z.

### OKX — the funding grid is a venue property, not a constant

Two separate failures, one root cause: **OKX lists no 1 h symbols**.

1. At 16:00Z its entry rested unfilled — a 0.5 % cross on a thin alt (`BEAT`) never reached the
   book, and the run lost its settlement. Hence the escalating ladder above.
2. At 17:00Z the scan found *zero eligible symbols*. 17:00 is 1 h-aligned and nothing else, so
   nothing on OKX settles then. The 16:00Z pass had only worked because that hour is also 4 h- and
   8 h-aligned — the bug looked like a pass.

The window now targets the venue's own shortest listed cadence, so the target is structurally
non-empty everywhere. **Run all five at a 4 h-aligned hour** to share one boundary.

## Binance

- **ccxt *throws* its symbol-less `fetchOpenOrders` warning.** The account-wide open-order
  read (preflight, flat verification) passes no symbol by design; ccxt answers with a
  stricter-rate-limit *warning* raised as an exception, so every such read failed. Acked once
  at client construction: `options.fetchOpenOrders.warnWithoutSymbol = false`
  (`src/adapters/exchanges/binance/factory.ts`). This affects the **production adapter**, not
  just the harness — testnet never surfaced it because its `assert-flat` scoped the read to BTC.
- **Benign account-setup codes arrive as errors:** `-4046` ("no need to change margin type")
  and `-4059` ("no need to change position side") on an already-configured account. Both are
  swallowed by account setup but log as `unmapped venue error code`.
- **Prices reach the venue as decimal strings — float noise is a hard reject.** `order-lifecycle`
  rests at `last × 0.97`, which is off-tick for most last prices; Binance answers *"Precision is
  over the maximum defined for this asset."* (Several earlier runs passed only because ADA's
  last price happened to make `× 0.97` land on the tick.) Rounding with `roundPrice` was not
  enough: `Math.round(v/step) * step` is itself lossy, and the venue received
  `price: "0.15960000000000002"` — same rejection, one layer down. Two fixes:
  - `src/live/checks/order-lifecycle.ts` tick-rounds the band price in `priceCandidates`,
    *before* `pickCheapestSymbol`, so the picker prices the exact number that gets submitted.
  - `src/core/sizing/sizing.ts` strips the float noise from every on-grid product
    (`onGrid()`, 15 significant digits) — `roundToStep`, `floorToStep` and `ceilToStep` all
    route through it. This is a **core** fix, not a harness one: any live limit order or
    lot-stepped qty could have carried the same unparseable decimal into 0480.
- The native SDK warns that `newClientOrderId` lacks its broker prefix. Cosmetic — the order
  is accepted and the engine id must stay verbatim (`10` §4).

## Bybit

Clean. Preflight, order lifecycle, cap rejection and teardown all passed unchanged on the
first live run.

## KuCoin

The plan expected KuCoin's first real order to fail, and it did — twice, in sequence. Both
are consequences of the same venue shape: **KuCoin states margin mode and leverage per order**
rather than per account.

1. `Leverage parameter invalid.` — KuCoin has no isolated-leverage endpoint, so `setLeverage`
   only *records* the value and the submit carries it. With nothing recorded the field is
   omitted, and an isolated order without `leverage` is rejected.
2. `330005` — *"The order's margin mode does not match the selected one."* The submit states
   `marginMode: ISOLATED` against a symbol the account still held in cross.

Fix (`src/live/checks/order-lifecycle.ts`): do the engine's per-instrument account setup
before the submit — `setMarginMode(symbol, 'isolated')` then `setLeverage(symbol, 1)`. Both
are no-ops on the venues that switch account-wide, so the check stays venue-generic. Leverage
`1` keeps the capped position fully margined.

## OKX — an orphan cross-margin position the flatten path could not close

`StrategySubAccount5` carried a position this repo did not open: `GLW/USDT:USDT` short
`0.04` contracts (~6 USD notional, entry `181.5`), **cross** margin, net position mode.

Preflight refused the sub-account, correctly, and no order was placed. Teardown's flatten
then failed on it with OKX `51169` — *"you don't have any positions in this direction for
this contract to reduce or close"*:

> The OKX adapter submits **`tdMode: 'isolated'` on every order** (there is no margin-mode
> switch on this venue). A reduce-only isolated close therefore cannot see — and cannot
> close — a **cross** position. Any position not opened by this engine is unclosable by its
> flatten path.

This is a real gap, not a harness artifact: `flattenAll` is also the kill switch's path
(`13` §4). It only bites for positions opened outside the engine, since the engine itself only
ever opens isolated ones — but a kill switch that cannot close every position it can *see* is
worth carrying into 0480.

Resolved by closing the orphan out-of-band — a market reduce-only with `tdMode` taken from the
position's own `marginMode` rather than the adapter's fixed `isolated`. OKX then passed 4/4.

## Bitget — Classic Account mode blocks the whole v3 API

Every private read failed with `40084`: *"You are in Classic Account mode, and the Unified
Account API is not supported at this time."* The adapter is deliberately **v3 / UTA-only**
(`src/adapters/CLAUDE.md` quirk table), so this is an account setting, not a code gap.
Preflight aggregated all four violations (balance, positions, open orders, position mode) and
placed no order. Resolved by upgrading sub-account `9932607584` to Unified (UTA v3) in the
Bitget UI; it then passed 4/4 with no code change. **A Classic sub-account cannot run this
engine at all** — worth checking before provisioning any new Bitget account (0520).

## SIGINT drill — teardown needed a second pass

Drill: kill the run while the `order-lifecycle` order is resting, and confirm teardown ends
the account flat.

It took two fixes, and the second only appeared because the first was verified.

**1. The in-flight submit.** The first drill **left a real order resting on Binance**
(~5.12 USD ADA limit) while reporting `verifiedFlat: false` with an empty `errors[]`. The
signal arrived while `placeOrder` was still travelling, so the order landed **after** the
cancel sweep read the book and **before** the verification read it. One pass could only
observe the leftover, never remove it. Fix: run sweep → flatten → verify as a bounded loop,
`TEARDOWN_ATTEMPTS = 2`, exiting early once verified flat.

**2. The false flat.** With the loop in place the next drill reported `flat: yes` — and the
*following* run's preflight then found that drill's order still resting. Binance's
account-wide order read had lagged the submit, so the first verification returned a **false
flat**, which ended the loop before the second sweep could run. A retry loop is worthless if
its exit condition can lie. Fix: `VERIFY_SETTLE_MS = 3000` before every verification read, so
the venue's own view has time to show an order that exists.

Both are covered by `test/unit/live/teardown.test.ts` ("re-sweeps an order that landed between
the sweep read and the verification read"). Lesson worth keeping: **always prove a teardown
with an independent follow-up run**, never with the teardown's own report.

The rest of the machinery behaved: the CLI exited `1` on every interrupted drill and printed
the MANUAL INTERVENTION line naming the sub-account. A drill also surfaces a benign
`-2011 Unknown order sent` — the check's own cleanup-cancel racing the sweep's cancel of the
same order.

## Unmapped venue error codes seen live

Each logged `unmapped venue error code`; none is fatal, all are candidates for the taxonomy:

| Venue | Code | Meaning |
|---|---|---|
| binance | `-4046` | no need to change margin type (already isolated) |
| binance | `-4059` | no need to change position side (already one-way) |
| okx | `51169` | close rejected — no position on that side *in that margin mode* |
| bitget | `40084` | Classic Account mode, UTA API unsupported |
| kucoin | `330005` | order margin mode does not match the symbol's |

## IP allowlist

The live keys are IP-pinned to `178.104.x.x`. From any other address every venue fails auth;
preflight rewrites those failures to name the allowlist hypothesis rather than reporting an
opaque signature error.
