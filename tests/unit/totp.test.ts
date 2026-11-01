import { ScureBase32Plugin } from '@otplib/plugin-base32-scure'
import { WebCryptoPlugin } from '@otplib/plugin-crypto-web'
import { TOTP } from '@otplib/totp'
import { describe, expect, it } from 'vitest'

import { AuthError } from '../../src/services/auth/error'
import { decryptTotpSecret, encryptTotpSecret } from '../../src/services/auth/totp/crypto'

describe('TOTP Cryptography and AAD Binding', () => {
  const currentKey = {
    id: 'key-2026',
    key: new Uint8Array(32).fill(0x42),
  }
  const retiredKey = {
    id: 'key-2025',
    key: new Uint8Array(32).fill(0x24),
  }
  const allKeys = new Map([
    [currentKey.id, currentKey],
    [retiredKey.id, retiredKey],
  ])

  const sub = 'user_12345'
  const factorId = 'factor_abcde'
  const secret = 'JBSWY3DPEHPK3PXP'

  it('encrypts and successfully decrypts secret with identical binding', async () => {
    const encrypted = await encryptTotpSecret(secret, currentKey, sub, factorId)
    expect(encrypted.length).toBeGreaterThan(16)

    const decrypted = await decryptTotpSecret(encrypted, allKeys, sub, factorId)
    expect(decrypted.secret).toBe(secret)
    expect(decrypted.keyId).toBe(currentKey.id)
  })

  it('fails decryption if sub is modified (AAD bound check)', async () => {
    const encrypted = await encryptTotpSecret(secret, currentKey, sub, factorId)
    await expect(decryptTotpSecret(encrypted, allKeys, 'attacker_sub', factorId)).rejects.toThrow(
      AuthError,
    )
  })

  it('fails decryption if factorId is modified (AAD bound check)', async () => {
    const encrypted = await encryptTotpSecret(secret, currentKey, sub, factorId)
    await expect(decryptTotpSecret(encrypted, allKeys, sub, 'other_factor')).rejects.toThrow(
      AuthError,
    )
  })

  it('fails decryption if payload bytes are tampered', async () => {
    const encrypted = await encryptTotpSecret(secret, currentKey, sub, factorId)
    encrypted[encrypted.length - 1] ^= 0xff // flip last bit in auth tag

    await expect(decryptTotpSecret(encrypted, allKeys, sub, factorId)).rejects.toThrow(AuthError)
  })

  it('can decrypt using retired key when currentKey rotated', async () => {
    const encryptedOld = await encryptTotpSecret(secret, retiredKey, sub, factorId)
    const decrypted = await decryptTotpSecret(encryptedOld, allKeys, sub, factorId)
    expect(decrypted.secret).toBe(secret)
    expect(decrypted.keyId).toBe(retiredKey.id)
  })
})

describe('TOTP Verification and Anti-Replay (RFC 6238)', () => {
  const otplib = new TOTP({
    crypto: new WebCryptoPlugin(),
    base32: new ScureBase32Plugin(),
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  })

  // RFC 6238 ASCII secret: "12345678901234567890" in Base32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  it('generates valid token and verifies with afterTimeStep constraint', async () => {
    const epoch = 59 // time = 59s -> step = floor(59/30) = 1
    const token = await otplib.generate({ secret: rfcSecret, epoch })

    // Normal verify at same epoch
    const res1 = await otplib.verify(token, {
      secret: rfcSecret,
      epoch,
    })
    expect(res1.valid).toBe(true)
    if (res1.valid) {
      expect(res1.timeStep).toBe(1)
    }

    // Replay with afterTimeStep equal to current step must be rejected!
    const resReplay = await otplib.verify(token, {
      secret: rfcSecret,
      epoch,
      afterTimeStep: 1,
    })
    expect(resReplay.valid).toBe(false)

    // A newer time step (step 2) must be accepted
    const nextEpoch = 65
    const token2 = await otplib.generate({ secret: rfcSecret, epoch: nextEpoch })
    const resNext = await otplib.verify(token2, {
      secret: rfcSecret,
      epoch: nextEpoch,
      afterTimeStep: 1,
    })
    expect(resNext.valid).toBe(true)
    if (resNext.valid) {
      expect(resNext.timeStep).toBe(2)
    }
  })

  it('rejects wrong token or expired token', async () => {
    const res = await otplib.verify('000000', {
      secret: rfcSecret,
      epoch: 59,
    })
    expect(res.valid).toBe(false)
  })
})
