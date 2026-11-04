/**
 * Visitor declaration and configuration resolution.
 *
 * @module
 */

import { serialize } from 'hono/utils/cookie'

import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import { resolveStaticPath } from '../../http/url'
import { DEFAULT_VISITOR_PATH } from './defaults'
import type { ResolvedVisitorsConfig, VisitorsConfig } from './types'

export const DEFAULT_VISITORS_CONFIG = {
  cookieName: 'visitor_id',
  expiresIn: 15_552_000_000,
  path: DEFAULT_VISITOR_PATH,
  cookie: {
    path: '/',
    sameSite: 'lax',
  },
} as const

/**
 * Resolves and validates visitor configuration, materializing defaults.
 *
 * @param input - Raw configuration object or environment factory.
 * @param env - Owning application or event environment.
 * @param production - Whether the host is running in production mode.
 * @returns Fully resolved visitors configuration.
 * @throws {Error} If secret is missing or parameters are malformed.
 */
export function resolveVisitorsConfig(
  input: VisitorsConfig | ((env: any) => VisitorsConfig),
  env: unknown,
  production = false,
): ResolvedVisitorsConfig {
  const evaluated = evaluateDeclaration(input, env, 'visitors')
  if (!evaluated || typeof evaluated !== 'object') {
    throw new Error('Visitors configuration must be an object.')
  }

  const { secret, cookieName, expiresIn, path, cookie } = evaluated

  if (typeof secret !== 'string' || new TextEncoder().encode(secret).length < 32) {
    throw new Error('Visitors secret must contain at least 32 UTF-8 bytes.')
  }

  const resolvedCookieName = cookieName ?? DEFAULT_VISITORS_CONFIG.cookieName
  if (typeof resolvedCookieName !== 'string' || resolvedCookieName.trim() === '') {
    throw new Error('Visitors cookieName must be a non-empty string.')
  }
  const resolvedExpiresIn = expiresIn ?? DEFAULT_VISITORS_CONFIG.expiresIn
  if (
    !Number.isSafeInteger(resolvedExpiresIn) ||
    resolvedExpiresIn < 1_000 ||
    resolvedExpiresIn > 34_560_000_000
  ) {
    throw new Error('Visitors expiresIn must be an integer from 1000 to 34560000000 milliseconds.')
  }

  const resolvedPath = resolveStaticPath(path ?? DEFAULT_VISITORS_CONFIG.path, 'Visitors path')

  const cookiePath = cookie?.path ?? DEFAULT_VISITORS_CONFIG.cookie.path
  if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/')) {
    throw new Error('Visitors cookie.path must be an absolute path starting with "/".')
  }

  const cookieSameSite = cookie?.sameSite ?? DEFAULT_VISITORS_CONFIG.cookie.sameSite
  if (!['lax', 'strict', 'none'].includes(cookieSameSite)) {
    throw new Error(`Invalid sameSite attribute "${cookieSameSite}" for visitors cookie.`)
  }

  const cookieSecure = cookie?.secure ?? (cookieSameSite === 'none' ? true : production)
  if (cookieSameSite === 'none' && !cookieSecure) {
    throw new Error('Visitors cookie with sameSite="none" requires secure=true.')
  }

  const config: ResolvedVisitorsConfig = {
    secret,
    cookieName: resolvedCookieName,
    expiresIn: resolvedExpiresIn,
    path: resolvedPath,
    cookie: {
      path: cookiePath,
      domain: cookie?.domain,
      sameSite: cookieSameSite,
      secure: cookieSecure,
      httpOnly: true,
    },
  }

  // Reuse the selected serializer's name, attribute, and cookie-prefix constraints at entry.
  try {
    serialize(config.cookieName, '', config.cookie)
  } catch (cause) {
    throw new Error('Invalid visitors cookie configuration.', { cause })
  }
  return config
}

/** Visitors declaration retaining its concrete configuration and environment requirements. */
export interface VisitorsDeclaration extends BaseDeclaration<'visitors', VisitorsConfig> {}

/**
 * Declares visitor identity capability for the application.
 *
 * @param config - Static visitor settings.
 * @returns The visitors declaration consumed by generated assembly.
 */
export function defineVisitors(config: VisitorsConfig): VisitorsDeclaration

/**
 * Declares visitor identity capability resolved once during application creation or per event.
 *
 * @param factory - Receives the owning instance or event environment and returns visitor settings.
 * @returns The visitors declaration with typed environment requirements.
 */
export function defineVisitors<E>(
  factory: (env: E) => VisitorsConfig,
): VisitorsDeclaration & RequiresEnv<E>

export function defineVisitors(
  input: VisitorsConfig | ((env: any) => VisitorsConfig),
): VisitorsDeclaration {
  return {
    kind: 'visitors',
    value: input,
    isFactory: typeof input === 'function',
  }
}
