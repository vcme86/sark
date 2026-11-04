/**
 * Cryptographic operations and verification for MFA recovery codes.
 *
 * @module
 */

import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

/** Normalizes a recovery code by stripping separators and uppercasing. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[-\s]/g, '').toUpperCase()
}

/**
 * Generates high-entropy recovery codes using 80-bit cryptographic randomness.
 * Formatted as readable 4-character chunks: `XXXX-XXXX-XXXX-XXXX-XXXX`.
 *
 * @param count - Number of codes to generate.
 * @returns Plaintext codes; callers persist only their hashes.
 */
export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(10)
    crypto.getRandomValues(bytes)
    const chars = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
    codes.push(chars.match(/.{4}/g)!.join('-'))
  }
  return codes
}

/** Computes SHA-256 digest of a normalized recovery code. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const normalized = normalizeRecoveryCode(code)
  const encoded = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean
  }
  return subtle.timingSafeEqual ? subtle.timingSafeEqual(a, b) : nodeTimingSafeEqual(a, b)
}

/**
 * Compares every stored digest using the host's timing-safe primitive.
 * @param inputCode - Entered recovery code; separators and letter case are normalized.
 * @param hashes - Stored SHA-256 digests for this subject.
 * @returns The matching index, if any; persistence consumes it separately under revision control.
 */
export async function verifyRecoveryCode(
  inputCode: string,
  hashes: readonly string[],
): Promise<{ valid: boolean; matchedIndex?: number }> {
  if (typeof inputCode !== 'string') return { valid: false }
  const inputHash = await hashRecoveryCode(inputCode)
  const inputBytes = Buffer.from(inputHash, 'hex')
  let matchedIndex = -1

  for (let i = 0; i < hashes.length; i++) {
    const targetBytes = Buffer.from(hashes[i], 'hex')
    const matched = timingSafeEqual(inputBytes, targetBytes)
    if (matched && matchedIndex === -1) {
      matchedIndex = i
    }
  }

  if (matchedIndex >= 0) {
    return { valid: true, matchedIndex }
  }
  return { valid: false }
}
