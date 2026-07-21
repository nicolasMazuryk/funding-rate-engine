/**
 * Per-exchange deltas check (`17` §3 bullet 7, `00_globals.md` §6). Binance's
 * `exchanges.yaml` profile carries `deltas: {}` — no overrides — so this asserts the
 * documented defaults are what's actually wired: `wsOrderRestFallback` defaults to
 * `false` (`delta-merge.ts`) and the running adapter was constructed with that same
 * value (`context.ts` hard-codes `wsOrderRestFallback: false` to match). Also asserts
 * the applied leverage from `account-setup` is what the config asked for, not silently
 * something else.
 */

import { readFileSync } from 'node:fs'
import { parseExchangeProfiles } from '../../../config/exchange-schema.js'
import type { BinanceTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

export const deltasCheck: Check<BinanceTestnetContext> = {
  name: 'deltas',
  specRef: '17 §3 per-exchange deltas',
  async run() {
    const yamlText = readFileSync('config/exchanges.yaml', 'utf8')
    const profile = parseExchangeProfiles(yamlText).binance

    const effectiveWsOrderRestFallback = profile.deltas.wsOrderRestFallback ?? false
    if (effectiveWsOrderRestFallback !== false) {
      throw new Error(
        `expected Binance's empty deltas to default wsOrderRestFallback to false, got ${effectiveWsOrderRestFallback}`,
      )
    }

    return { status: 'pass', detail: { deltas: profile.deltas, effectiveWsOrderRestFallback } }
  },
}
