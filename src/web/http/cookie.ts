import type { Context } from 'hono'
import {
  deleteCookie as honoDeleteCookie,
  getCookie as honoGetCookie,
  getSignedCookie as honoGetSignedCookie,
  setCookie as honoSetCookie,
  setSignedCookie as honoSetSignedCookie,
} from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'

import { getCurrentScope } from '../../core/context'
import type { ResolvedCookieConfig } from './config'

function getCookieConfig(): ResolvedCookieConfig {
  const config = getCurrentScope()?.config
  if (!config) throw new Error('Application Cookie helpers require a Sark request scope.')
  return config.cookie
}

function resolveEffectiveCookieOptions(overrides?: CookieOptions): CookieOptions {
  const config = getCookieConfig()
  return {
    ...overrides,
    sameSite: overrides?.sameSite ?? config.sameSite,
    secure: overrides?.secure ?? config.secure,
  }
}

/**
 * Reads an unsigned cookie from the request using Hono's cookie parser.
 *
 * @param ctx - Hono context containing the incoming Cookie header.
 * @param key - Cookie name to read.
 * @returns The decoded cookie value, or undefined when no matching cookie is available.
 */
export function getCookie(ctx: Context, key: string): string | undefined {
  return honoGetCookie(ctx, key)
}

/**
 * Appends a response cookie, applying application defaults before explicit options.
 *
 * @param ctx - Hono context receiving the Set-Cookie header.
 * @param key - Cookie name.
 * @param value - Value to serialize.
 * @param options - Serialization options overriding the configured SameSite and Secure defaults.
 * @throws If called outside a Sark request scope or Cookie serialization fails.
 */
export function setCookie(ctx: Context, key: string, value: string, options?: CookieOptions): void {
  honoSetCookie(ctx, key, value, resolveEffectiveCookieOptions(options))
}

/**
 * Expires a response cookie using the same application defaults as setCookie.
 *
 * @param ctx - Hono context receiving the Set-Cookie header.
 * @param key - Cookie name to expire.
 * @param options - Cookie attributes; path and domain must match the cookie being removed.
 * @throws If called outside a Sark request scope or Cookie serialization fails.
 */
export function deleteCookie(ctx: Context, key: string, options?: CookieOptions): void {
  honoDeleteCookie(ctx, key, resolveEffectiveCookieOptions(options))
}

/**
 * Reads and verifies a signed Cookie value asynchronously using HMAC.
 *
 * @param ctx - Hono context containing the incoming Cookie header.
 * @param secretOrKey - Cookie name when using the configured secret; otherwise the explicit secret.
 * @param key - Cookie name when an explicit secret is supplied.
 * @returns The verified value, false for an invalid signature, or undefined if no cookie is available.
 * @throws {Error} If neither an explicit nor a configured signing secret is available.
 */
export async function getSignedCookie(
  ctx: Context,
  secretOrKey: string,
  key?: string,
): Promise<string | false | undefined> {
  const secret = key !== undefined ? secretOrKey : getCookieConfig().secret
  const cookieKey = key !== undefined ? key : secretOrKey
  if (!secret) {
    throw new Error('Cookie signing secret is required but not provided or configured.')
  }
  return honoGetSignedCookie(ctx, secret, cookieKey)
}

/**
 * Signs and appends a cookie, applying application defaults before explicit options.
 *
 * @param ctx - Hono context receiving the Set-Cookie header.
 * @param key - Cookie name.
 * @param value - Value to sign and serialize.
 * @param secretOrOptions - Explicit signing secret, or cookie options when using the configured secret.
 * @param options - Cookie options when secretOrOptions supplies an explicit secret.
 * @returns A promise resolving after signing and appending the Set-Cookie header.
 * @throws {Error} If neither an explicit nor a configured signing secret is available.
 * @throws If signing or cookie serialization fails.
 */
export async function setSignedCookie(
  ctx: Context,
  key: string,
  value: string,
  secretOrOptions?: string | CookieOptions,
  options?: CookieOptions,
): Promise<void> {
  const secret = typeof secretOrOptions === 'string' ? secretOrOptions : getCookieConfig().secret
  const opts = typeof secretOrOptions === 'string' ? options : secretOrOptions
  if (!secret) {
    throw new Error('Cookie signing secret is required but not provided or configured.')
  }
  await honoSetSignedCookie(ctx, key, value, secret, resolveEffectiveCookieOptions(opts))
}
