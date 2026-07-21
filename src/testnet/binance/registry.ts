/**
 * Binance testnet check registry (task 0260; `17` §3 checklist). Order matters:
 * public/credential-free checks first, then the serialized credentialed
 * account-state checks, `assert-flat` last so the account always ends clean
 * regardless of which earlier check ran or failed.
 */

import type { BinanceTestnetContext } from '../context.js'
import type { Check } from '../types.js'
import { accountSetupCheck } from './checks/account-setup.js'
import { assertFlatCheck } from './checks/assert-flat.js'
import { deltasCheck } from './checks/deltas.js'
import { errorTaxonomyCheck } from './checks/error-taxonomy.js'
import { marketsCheck } from './checks/markets.js'
import { orderPathCheck } from './checks/order-path.js'
import { rateLimiterCheck } from './checks/rate-limiter.js'
import { streamsCheck } from './checks/streams.js'

export const binanceTestnetChecks: readonly Check<BinanceTestnetContext>[] = [
  marketsCheck,
  rateLimiterCheck,
  deltasCheck,
  accountSetupCheck,
  orderPathCheck,
  streamsCheck,
  errorTaxonomyCheck,
  assertFlatCheck,
]
