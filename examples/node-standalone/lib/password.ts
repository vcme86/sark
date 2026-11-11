import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_OPTIONS = {
  cost: 32_768,
  blockSize: 8,
  parallelization: 3,
  maxmem: 64 * 1024 * 1024,
}
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`

/**
 * Derives a 64-byte scrypt key.
 *
 * @param password - Password to hash.
 * @param salt - Stored salt.
 * @returns Derived key.
 */
function deriveKey(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

/**
 * Hashes a password using a fresh salt.
 *
 *
 * @param password - Password to hash.
 * @returns Salt and derived key, separated by a colon.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await deriveKey(password, salt)
  return `${salt}:${key.toString('hex')}`
}

/**
 * Checks a password against a stored salted hash.
 *
 *
 * @param password - Password to verify.
 * @param hash - Stored hash. An omitted hash incurs the same verification cost.
 * @returns Whether the password matches.
 */
export async function verifyPassword(password: string, hash?: string): Promise<boolean> {
  const [salt, encodedKey] = (hash ?? DUMMY_HASH).split(':')
  if (!salt || !encodedKey) return false
  const expected = Buffer.from(encodedKey, 'hex')
  const actual = await deriveKey(password, salt)
  const matches = actual.length === expected.length && timingSafeEqual(actual, expected)
  return hash !== undefined && matches
}
