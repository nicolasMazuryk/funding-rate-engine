/**
 * Live sub-account registry loader (task 0470).
 *
 * Two files, joined on `(exchange, strategy)`:
 *  - `config/subaccounts.yaml` — **committed, secret-free**: which sub-account a given
 *    (exchange, strategy) pair trades, its label, its allocated capital, its status.
 *  - `config/subaccounts.secrets.yaml` — **gitignored**: the API credentials for those
 *    same rows. A committed `.example` documents the shape.
 *
 * Same dialect as the other config parsers (`09_configuration.md` §5): text in, frozen
 * camelCase out, `parseYamlMapping` prologue, `.strict()` Zod, every violation surfaced
 * as a `ConfigParseError` — no raw ZodError escapes.
 *
 * Secrets are carried under the key `secrets`, which is exactly what
 * `PINO_REDACTION_PATHS` censors (`secrets.apiKey` / `secrets.apiSecret` /
 * `secrets.apiPassphrase`), and {@link LiveSubaccount} defines a `toJSON` that drops the
 * key outright — so neither a log line nor a `JSON.stringify` of a joined row can leak a
 * credential.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { STRATEGY_IDS, type StrategyId } from './canonical.js'
import { ConfigParseError } from './errors.js'
import { EXCHANGE_IDS, type ExchangeId } from './exchange-schema.js'
import { zodErrorToConfigError } from './schema.js'
import { parseYamlMapping } from './yaml.js'

/**
 * Spec-09 long-form strategy names accepted on disk and normalized to the canonical short
 * {@link StrategyId} used everywhere else (task 0100). The provisioning tooling that wrote
 * the original registry speaks the long form; the engine only ever speaks the short one.
 */
export const SPEC09_STRATEGY_ALIASES: Readonly<Record<string, StrategyId>> = {
  strategy_1: 's1',
  strategy_1_ws: 's1-ws',
  strategy_2: 's2',
  strategy_3a: 's3a',
  strategy_4_1a: 's4-1a',
  strategy_4_2a: 's4-2a',
  strategy_6: 's6',
}

/** Venues whose API requires a passphrase alongside key + secret. */
const PASSPHRASE_EXCHANGES: readonly ExchangeId[] = ['okx', 'kucoin', 'bitget']

const ExchangeSchema = z.enum([...EXCHANGE_IDS])

/** Short id, or a spec-09 long-form alias normalized to it. */
const StrategySchema = z.preprocess(
  (v) => (typeof v === 'string' && v in SPEC09_STRATEGY_ALIASES ? SPEC09_STRATEGY_ALIASES[v] : v),
  z.enum([...STRATEGY_IDS]),
)

const SubaccountRowYamlSchema = z
  .object({
    exchange: ExchangeSchema,
    strategy: StrategySchema,
    sub_account_id: z.string().min(1),
    sub_account_label: z.string().min(1),
    allocated_capital_usdt: z.number().gte(0),
    status: z.enum(['active', 'idle']),
  })
  .strict()

const SubaccountsYamlSchema = z.object({ subaccounts: z.array(SubaccountRowYamlSchema).min(1) }).strict()

const SubaccountSecretYamlSchema = z
  .object({
    exchange: ExchangeSchema,
    strategy: StrategySchema,
    api_key: z.string().min(1),
    api_secret: z.string().min(1),
    api_passphrase: z.string().min(1).optional(),
  })
  .strict()
  // Venue-shape check here rather than at use time: a bitget row without a passphrase
  // authenticates nowhere, and finding that out mid-run means a live order path fails.
  .superRefine((row, ctx) => {
    const needed = PASSPHRASE_EXCHANGES.includes(row.exchange)
    if (needed && row.api_passphrase === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['api_passphrase'],
        message: `${row.exchange} requires an api_passphrase`,
        params: { code: 'missing_passphrase' },
      })
    }
    if (!needed && row.api_passphrase !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['api_passphrase'],
        message: `${row.exchange} takes no api_passphrase`,
        params: { code: 'unexpected_passphrase' },
      })
    }
  })

const SubaccountSecretsYamlSchema = z.object({ secrets: z.array(SubaccountSecretYamlSchema).min(1) }).strict()

// ── Live shapes ──────────────────────────────────────────────────────────────

/** One secret-free registry row. */
export interface SubaccountRow {
  readonly exchange: ExchangeId
  readonly strategy: StrategyId
  readonly subAccountId: string
  readonly subAccountLabel: string
  readonly allocatedCapitalUsdt: number
  readonly status: 'active' | 'idle'
}

/** Credentials for one row. `apiPassphrase` present iff the venue requires one. */
export interface SubaccountSecrets {
  readonly apiKey: string
  readonly apiSecret: string
  readonly apiPassphrase?: string
}

/** A registry row joined to its credentials. `JSON.stringify` yields the secret-free row. */
export interface LiveSubaccount extends SubaccountRow {
  readonly secrets: SubaccountSecrets
  toJSON(): SubaccountRow
}

/** Join key. Both files are keyed on the same `(exchange, strategy)` pair. */
function key(exchange: ExchangeId, strategy: StrategyId): string {
  return `${exchange}/${strategy}`
}

// ── Pure parsers ─────────────────────────────────────────────────────────────

/** Index rows by {@link key}, rejecting duplicates with `code`. */
function indexUnique<T extends { exchange: ExchangeId; strategy: StrategyId }>(
  rows: readonly T[],
  prefix: string,
  code: string,
): Map<string, T> {
  const byKey = new Map<string, T>()
  for (const row of rows) {
    const k = key(row.exchange, row.strategy)
    if (byKey.has(k)) throw new ConfigParseError(prefix, `duplicate row for '${k}'`, code)
    byKey.set(k, row)
  }
  return byKey
}

/** Parse the committed secret-free registry. Pure — the caller reads disk. */
export function parseSubaccounts(yamlText: string): readonly SubaccountRow[] {
  const raw = parseYamlMapping(yamlText, 'subaccounts config must be a YAML mapping')
  const res = SubaccountsYamlSchema.safeParse(raw)
  if (!res.success) throw zodErrorToConfigError(res.error, 'subaccounts')

  const rows = res.data.subaccounts.map(
    (r): SubaccountRow => ({
      exchange: r.exchange,
      strategy: r.strategy,
      subAccountId: r.sub_account_id,
      subAccountLabel: r.sub_account_label,
      allocatedCapitalUsdt: r.allocated_capital_usdt,
      status: r.status,
    }),
  )
  indexUnique(rows, 'subaccounts', 'duplicate_subaccount')
  return rows
}

interface SecretRow extends SubaccountSecrets {
  readonly exchange: ExchangeId
  readonly strategy: StrategyId
}

/** Parse the gitignored credentials file. Pure — the caller reads disk. */
export function parseSubaccountSecrets(yamlText: string): readonly SecretRow[] {
  const raw = parseYamlMapping(yamlText, 'subaccount secrets must be a YAML mapping')
  const res = SubaccountSecretsYamlSchema.safeParse(raw)
  if (!res.success) throw zodErrorToConfigError(res.error, 'subaccount-secrets')

  const rows = res.data.secrets.map(
    (r): SecretRow => ({
      exchange: r.exchange,
      strategy: r.strategy,
      apiKey: r.api_key,
      apiSecret: r.api_secret,
      ...(r.api_passphrase !== undefined ? { apiPassphrase: r.api_passphrase } : {}),
    }),
  )
  indexUnique(rows, 'subaccount-secrets', 'duplicate_secret')
  return rows
}

export interface SubaccountSelector {
  readonly exchange: ExchangeId
  readonly strategy: StrategyId
}

export interface SubaccountSources {
  readonly subaccountsYamlText: string
  readonly secretsYamlText: string
}

/**
 * Resolve one `(exchange, strategy)` pair to its credentialed sub-account. Pure.
 * Throws `ConfigParseError` on an unknown pair (`unknown_subaccount`), a non-`active`
 * row (`subaccount_inactive`), or a row with no matching credentials (`missing_secret`).
 */
export function selectSubaccount(sources: SubaccountSources, selector: SubaccountSelector): LiveSubaccount {
  const k = key(selector.exchange, selector.strategy)
  const rows = indexUnique(parseSubaccounts(sources.subaccountsYamlText), 'subaccounts', 'duplicate_subaccount')

  const row = rows.get(k)
  if (row === undefined) {
    throw new ConfigParseError('subaccounts', `no sub-account for '${k}'`, 'unknown_subaccount')
  }
  if (row.status !== 'active') {
    throw new ConfigParseError(
      'subaccounts',
      `sub-account '${k}' has status '${row.status}', not 'active'`,
      'subaccount_inactive',
    )
  }

  const secrets = indexUnique(
    parseSubaccountSecrets(sources.secretsYamlText),
    'subaccount-secrets',
    'duplicate_secret',
  ).get(k)
  if (secrets === undefined) {
    throw new ConfigParseError(
      'subaccount-secrets',
      `no credentials for '${k}' — add a row to config/subaccounts.secrets.yaml`,
      'missing_secret',
    )
  }

  return {
    ...row,
    secrets: {
      apiKey: secrets.apiKey,
      apiSecret: secrets.apiSecret,
      ...(secrets.apiPassphrase !== undefined ? { apiPassphrase: secrets.apiPassphrase } : {}),
    },
    toJSON: () => row,
  }
}

export interface LoadSubaccountOptions extends SubaccountSelector {
  readonly configDir?: string
}

export const SUBACCOUNTS_FILE = 'subaccounts.yaml'
export const SUBACCOUNT_SECRETS_FILE = 'subaccounts.secrets.yaml'

/** Whether the gitignored credentials file exists at all — the live tier's skip signal. */
export function hasSubaccountSecrets(configDir = resolve(process.cwd(), 'config')): boolean {
  try {
    readFileSync(resolve(configDir, SUBACCOUNT_SECRETS_FILE), 'utf8')
    return true
  } catch {
    return false
  }
}

/** Disk wrapper around {@link selectSubaccount}. */
export function loadSubaccount(options: LoadSubaccountOptions): LiveSubaccount {
  const configDir = options.configDir ?? resolve(process.cwd(), 'config')
  const subaccountsYamlText = readFileSync(resolve(configDir, SUBACCOUNTS_FILE), 'utf8')

  let secretsYamlText: string
  try {
    secretsYamlText = readFileSync(resolve(configDir, SUBACCOUNT_SECRETS_FILE), 'utf8')
  } catch {
    throw new ConfigParseError(
      'subaccount-secrets',
      `missing ${SUBACCOUNT_SECRETS_FILE} — copy config/subaccounts.secrets.example.yaml and fill it in`,
      'missing_secrets_file',
    )
  }

  return selectSubaccount({ subaccountsYamlText, secretsYamlText }, options)
}
