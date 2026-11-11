import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Hashes a password using a fresh salt.
 *
 * @param {string} password - Password to hash.
 * @returns {string} Salt and derived key, separated by a colon.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

/**
 * Checks a password against a stored salted hash.
 *
 * @param {string} password - Password to verify.
 * @param {string} hash - Stored salt and derived key.
 * @returns {boolean} Whether the password matches.
 */
export function verifyPassword(password, hash) {
  const [salt, key] = hash.split(':')
  if (!salt || !key) return false
  const expected = Buffer.from(key, 'hex')
  const actual = scryptSync(password, salt, 64)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
