import { describe, expect, it } from 'vitest'
import { scaffoldOk } from '../../src/main.js'

describe('scaffold', () => {
  it('is ok', () => {
    expect(scaffoldOk()).toBe(true)
  })
})
