/**
 * Authenticated encryption for TOTP secrets using WebCrypto AES-256-GCM.
 *
 * @module
 */

import { AuthError } from '../error'
import type { TotpKey } from './types'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const CIPHER_VERSION = 1

function createAad(sub: string, factorId: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(`sub:${sub}|factorId:${factorId}`)
}

/**
 * Encrypts a plain Base32 TOTP secret using the active current key.
 *
 * @param secret - Plain Base32 secret string.
 * @param currentKey - Active encryption key.
 * @param sub - Associated subject identifier.
 * @param factorId - Associated factor identifier.
 * @returns Serialized encrypted payload.
 */
export async function encryptTotpSecret(
  secret: string,
  currentKey: TotpKey,
  sub: string,
  factorId: string,
): Promise<Uint8Array> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(currentKey.key),
    'AES-GCM',
    false,
    ['encrypt'],
  )

  const aad = createAad(sub, factorId)
  const plaintext = textEncoder.encode(secret)

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad,
    },
    cryptoKey,
    plaintext,
  )

  const keyIdBytes = textEncoder.encode(currentKey.id)

  const ciphertext = new Uint8Array(ciphertextBuffer)
  const totalLength = 1 + 1 + keyIdBytes.length + 12 + ciphertext.length
  const output = new Uint8Array(totalLength)

  let offset = 0
  output[offset++] = CIPHER_VERSION
  output[offset++] = keyIdBytes.length
  output.set(keyIdBytes, offset)
  offset += keyIdBytes.length
  output.set(iv, offset)
  offset += 12
  output.set(ciphertext, offset)

  return output
}

/**
 * Decrypts a TOTP secret payload, verifying subject and factorId binding.
 *
 * @param payload - Serialized encrypted payload.
 * @param allKeys - Lookup map of all available keys (current and retired).
 * @param sub - Associated subject identifier.
 * @param factorId - Associated factor identifier.
 * @returns Plain Base32 secret and the keyId used for decryption.
 * @throws AuthError with code key_unavailable if decryption fails or key is missing.
 */
export async function decryptTotpSecret(
  payload: Uint8Array,
  allKeys: ReadonlyMap<string, TotpKey>,
  sub: string,
  factorId: string,
): Promise<{ secret: string; keyId: string }> {
  if (payload.length < 2) {
    throw new AuthError('key_unavailable', 'Corrupted TOTP secret payload: too short.')
  }

  let offset = 0
  const version = payload[offset++]
  if (version !== CIPHER_VERSION) {
    throw new AuthError('key_unavailable', `Unsupported TOTP secret payload version ${version}.`)
  }

  const keyIdLen = payload[offset++]
  if (payload.length < 2 + keyIdLen + 12) {
    throw new AuthError('key_unavailable', 'Corrupted TOTP secret payload: header truncated.')
  }

  const keyId = textDecoder.decode(payload.subarray(offset, offset + keyIdLen))
  offset += keyIdLen

  const key = allKeys.get(keyId)
  if (!key) {
    throw new AuthError(
      'key_unavailable',
      `Decryption key "${keyId}" not found in current or retired keys.`,
    )
  }

  const iv = new Uint8Array(payload.subarray(offset, offset + 12))
  offset += 12

  const ciphertext = payload.subarray(offset)
  const aad = createAad(sub, factorId)

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(key.key),
      'AES-GCM',
      false,
      ['decrypt'],
    )

    const plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aad,
      },
      cryptoKey,
      new Uint8Array(ciphertext),
    )

    const secret = textDecoder.decode(plaintextBuffer)
    return { secret, keyId }
  } catch (err) {
    throw new AuthError(
      'key_unavailable',
      'Failed to decrypt TOTP secret: tag mismatch or corrupted data.',
      {
        details: err instanceof Error ? err.message : String(err),
      },
    )
  }
}
