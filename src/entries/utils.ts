/**
 * Standalone cookie parsing, serialization, and signing without request context.
 *
 * @module
 */

export {
  parse as parseCookie,
  parseSigned as parseSignedCookie,
  serialize as serializeCookie,
  serializeSigned as serializeSignedCookie,
} from 'hono/utils/cookie'

export type { Cookie, CookieConstraint, CookieOptions, SignedCookie } from 'hono/utils/cookie'
