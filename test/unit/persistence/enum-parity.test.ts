/**
 * Enum-parity drift guard (task 0360; R12-class). The Postgres `exit_reason` /
 * `error_code` pg-enums are single-sourced from the FSM's `EXIT_REASONS` /
 * `ERROR_CODES` `as const` arrays (`intent-machine.ts`). This asserts the pg-enum
 * `enumValues` and the source arrays stay **set-equal in both directions**, so a
 * member added to one but not migrated on the other is a failing test, not a
 * silent DB-write rejection at runtime. Mirrors the mirror-table pattern in
 * `test/unit/core/events/types.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { ERROR_CODES, EXIT_REASONS } from '../../../src/core/intent/intent-machine.js'
import { errorCodeEnum, exitReasonEnum } from '../../../src/persistence/db/schema.js'

describe('exit_reason / error_code enum parity', () => {
  it('exitReasonEnum matches EXIT_REASONS set-equal', () => {
    expect(new Set(exitReasonEnum.enumValues)).toEqual(new Set(EXIT_REASONS))
    expect(exitReasonEnum.enumValues).toHaveLength(EXIT_REASONS.length)
  })

  it('errorCodeEnum matches ERROR_CODES set-equal', () => {
    expect(new Set(errorCodeEnum.enumValues)).toEqual(new Set(ERROR_CODES))
    expect(errorCodeEnum.enumValues).toHaveLength(ERROR_CODES.length)
  })
})
