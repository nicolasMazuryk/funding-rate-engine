/**
 * KuCoin verification-tier check registry (task 0460) — the venue's `17` §3 checklist, minus the
 * bullets that cannot be honestly run here.
 *
 * **Six checks, not eight, and the two missing slots are absent rather than stubbed.** KuCoin
 * decommissioned its futures sandbox: there is no testnet domain, no demo flag and no demo
 * header (`../../adapters/exchanges/kucoin/factory.ts`), so the only account that exists is a
 * **live one holding real money**. Every check below is therefore a **read**. That rules out
 * two of the sibling registries' bullets outright:
 *
 *  - **`order-path`** — the whole point of that check is to submit, fill and cancel a real
 *    order. On live keys that is a real position with real P&L, so it does not exist here.
 *  - **`account-setup`** — position mode, margin mode and leverage are account-wide *writes*
 *    that would silently reconfigure a live account (and are refused outright while anything is
 *    open). So it does not exist here either.
 *
 * Neither is present as a file returning `skip`. A stub check would report a checklist bullet
 * this tier *has* — greened, in the summary, with a reason nobody reads — when the truth is
 * that the bullet is unrunnable on this venue. **An absent slot is clearer than a lying one**:
 * `total: 6` in the summary states the shape of what was verified, and this comment states why.
 *
 * Order is the siblings' order, minus those two: credential-free checks first, then the
 * credentialed reads, `assert-flat` last — though here it only ever *asserts* flatness and
 * never restores it (see `./checks/assert-flat.ts`).
 */

import type { KucoinLiveContext } from '../context.js'
import type { Check } from '../types.js'
import { assertFlatCheck } from './checks/assert-flat.js'
import { deltasCheck } from './checks/deltas.js'
import { errorTaxonomyCheck } from './checks/error-taxonomy.js'
import { marketsCheck } from './checks/markets.js'
import { rateLimiterCheck } from './checks/rate-limiter.js'
import { streamsCheck } from './checks/streams.js'

export const kucoinReadOnlyChecks: readonly Check<KucoinLiveContext>[] = [
  marketsCheck,
  rateLimiterCheck,
  deltasCheck,
  streamsCheck,
  errorTaxonomyCheck,
  assertFlatCheck,
]
