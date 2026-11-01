import { describe, expect, it } from 'vitest'

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../../src/services/auth/recovery/service'

describe('Recovery Codes Mechanism', () => {
  it('formats 80-bit random recovery codes in hexadecimal groups', () => {
    const codes = generateRecoveryCodes(10)
    expect(codes).toHaveLength(10)
    const set = new Set(codes)
    expect(set.size).toBe(10)
    for (const code of codes) {
      expect(code).toMatch(/^(?:[0-9A-F]{4}-){4}[0-9A-F]{4}$/)
    }
  })

  it('normalizes, hashes and matches recovery codes', async () => {
    const codes = generateRecoveryCodes(3)
    const hashes = await Promise.all(codes.map((c: string) => hashRecoveryCode(c)))

    expect(hashes).toHaveLength(3)

    // Whitespace and lowercase normalization
    const unformatted = codes[0].toLowerCase().replace(/-/g, ' ')
    const verify1 = await verifyRecoveryCode(unformatted, hashes)
    expect(verify1.valid).toBe(true)
    expect(verify1.matchedIndex).toBe(0)

    // Wrong code rejected
    const verifyWrong = await verifyRecoveryCode('0000-0000-0000-0000', hashes)
    expect(verifyWrong.valid).toBe(false)
  })
})
