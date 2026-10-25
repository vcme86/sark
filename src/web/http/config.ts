import type { MiddlewareHandler } from 'hono'
import type { cors as honoCors } from 'hono/cors'

import { type CompiledProxyRules, compileProxyRules } from './proxy'

type UpstreamCorsOptions = NonNullable<Parameters<typeof honoCors>[0]>

/** Hono CORS options with an explicit origin requirement. */
export interface CorsOptions extends Omit<UpstreamCorsOptions, 'origin'> {
  /** Allowed origin(s) or a function resolving allowed origin dynamically from request origin. */
  origin: NonNullable<UpstreamCorsOptions['origin']>
}

/** Core HTTP configuration options for the application. */
export interface HttpConfig {
  /**
   * Baseline security headers map, or `false` to disable all default security headers.
   * Individual header keys can be set to `false` to remove that default header,
   * or a string value to override it. Key matching is case-insensitive.
   *
   * @default
   * {
   *   'X-Content-Type-Options': 'nosniff',
   *   'X-Frame-Options': 'SAMEORIGIN',
   *   'Referrer-Policy': 'strict-origin-when-cross-origin'
   * }
   */
  headers?: Record<string, string | false | undefined> | false

  /**
   * Maximum allowed request body size in bytes.
   * Set to `false` to disable request body size limits.
   *
   * @default 1048576 (1 MiB)
   */
  bodyLimit?: number | false

  /**
   * Trusted proxy network ranges or keywords for resolving client IP and original protocols.
   * Supports CIDR blocks, specific IP addresses, or keywords `'loopback'` and `'private'`.
   * Pass an empty array `[]` to disable proxy forwarding header trust.
   *
   * @default ['loopback', 'private']
   */
  trustedProxies?: Array<'loopback' | 'private' | string>

  /** Application-wide default Cookie serialization and signing options. */
  cookie?: {
    /**
     * Secret key used for signing cookies with HMAC.
     * Used by `getSignedCookie` and `setSignedCookie` unless a secret is passed explicitly.
     */
    secret?: string

    /**
     * Default SameSite attribute for cookies issued by the application.
     * @default 'lax'
     */
    sameSite?: 'lax' | 'strict' | 'none'

    /**
     * Default Secure attribute for cookies issued by the application.
     * Defaults to `true` in production (`NODE_ENV === 'production'`), `false` otherwise.
     */
    secure?: boolean
  }

  /**
   * Cross-Origin Resource Sharing (CORS) policy.
   * Pass `false` to disable CORS, or `CorsOptions` with an explicit `origin`.
   *
   * @default false
   */
  cors?: false | CorsOptions

  /**
   * Cross-Site Request Forgery (CSRF) protection policy.
   * Enabled by default for state-changing requests (form and text submissions).
   * Pass `false` to disable, or an object with `origins` to allow additional origins.
   *
   * @default true
   */
  csrf?: boolean | { origins?: string[] }

  /**
   * Trailing slash URL normalization behavior:
   * - `'never'`: Redirects GET/HEAD requests with trailing slash to without trailing slash (308).
   * - `'always'`: Redirects GET/HEAD requests without trailing slash to with trailing slash (308).
   * - `'ignore'`: Disables redirection and accepts both URL variants.
   * Non-GET/HEAD methods match directly without redirecting to avoid body retransmission.
   *
   * @default 'never'
   */
  trailingSlash?: 'never' | 'always' | 'ignore'

  /**
   * Whether URL static path matching is case-sensitive.
   * Dynamic parameter values (e.g. `:id`) always preserve original case regardless of this setting.
   *
   * @default false
   */
  caseSensitive?: boolean

  /**
   * Allowed Host header value(s) for host validation.
   * When omitted or undefined, host validation is not restricted.
   *
   * @default undefined
   */
  hosts?: string | string[]

  /**
   * Global Hono middleware executed in declaration order after admission and before route handlers.
   *
   * @default []
   */
  middleware?: MiddlewareHandler[]
}

/** Standard baseline security headers applied to HTTP responses. */
export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

/** Cookie defaults available to request-bound helpers after application creation. */
export interface ResolvedCookieConfig {
  readonly sameSite: NonNullable<NonNullable<HttpConfig['cookie']>['sameSite']>
  readonly secure: boolean
  readonly secret?: string
}

/** Fully resolved HTTP configuration with all Sark defaults applied. */
export interface ResolvedHttpConfig {
  /** Production mode captured when the application is created. */
  readonly production: boolean
  readonly headers: Readonly<Record<string, string | false>> | false
  readonly bodyLimit: number | false
  readonly trustedProxies: readonly string[]
  /** Proxy matchers compiled once with the owning instance or event configuration. */
  readonly proxyRules: CompiledProxyRules
  readonly cookie: ResolvedCookieConfig
  readonly cors: false | CorsOptions
  readonly csrf: boolean | { origins?: string[] }
  readonly trailingSlash: 'never' | 'always' | 'ignore'
  readonly caseSensitive: boolean
  readonly hosts?: string | readonly string[]
  readonly middleware: readonly MiddlewareHandler[]
}

/** Environment-independent defaults; Secure is resolved when an application is created. */
export const DEFAULT_HTTP_CONFIG: Omit<
  ResolvedHttpConfig,
  'cookie' | 'production' | 'proxyRules'
> & {
  readonly cookie: Pick<ResolvedCookieConfig, 'sameSite'>
} = {
  headers: DEFAULT_SECURITY_HEADERS,
  bodyLimit: 1048576,
  trustedProxies: ['loopback', 'private'],
  cookie: { sameSite: 'lax' },
  cors: false,
  csrf: true,
  trailingSlash: 'never',
  caseSensitive: false,
  middleware: [],
}

/**
 * Resolves Cookie defaults without capturing production mode during module import.
 *
 * @param input - Application Cookie options; undefined fields retain their defaults.
 * @param production - Production mode resolved by the application configuration entry.
 * @returns Complete attributes and the optional explicitly configured signing secret.
 * @throws If SameSite or Secure has an unsupported value.
 */
function resolveCookieConfig(
  input: NonNullable<HttpConfig['cookie']>,
  production: boolean,
): ResolvedCookieConfig {
  const sameSite =
    input.sameSite === undefined ? DEFAULT_HTTP_CONFIG.cookie.sameSite : input.sameSite
  const secure = input.secure === undefined ? production : input.secure
  if (!['lax', 'strict', 'none'].includes(sameSite) || typeof secure !== 'boolean') {
    throw new Error('Invalid Cookie sameSite or secure configuration.')
  }
  return { sameSite, secure, secret: input.secret }
}

/**
 * Applies HTTP defaults, header overrides, and field-specific configuration merging.
 *
 * @param input - Application options; explicit false values disable the corresponding policy.
 * @param production - Host mode; standalone Node resolution reads the current process environment.
 * @returns Complete configuration with independent Sark-owned containers.
 * @throws If the body limit, URL policy, or Cookie options are invalid.
 */
export function resolveHttpConfig(
  input: HttpConfig = {},
  production = process.env.NODE_ENV === 'production',
): ResolvedHttpConfig {
  for (const [field, value] of Object.entries(input)) {
    if (value === null) throw new Error(`http.${field} does not accept null.`)
  }
  const bodyLimit = input.bodyLimit === undefined ? DEFAULT_HTTP_CONFIG.bodyLimit : input.bodyLimit
  const trailingSlash = input.trailingSlash ?? DEFAULT_HTTP_CONFIG.trailingSlash
  const caseSensitive = input.caseSensitive ?? DEFAULT_HTTP_CONFIG.caseSensitive
  assertBodyLimit(bodyLimit)
  if (
    !['never', 'always', 'ignore'].includes(trailingSlash) ||
    typeof caseSensitive !== 'boolean'
  ) {
    throw new Error('Invalid trailingSlash or caseSensitive configuration.')
  }

  let headers: Record<string, string | false> | false = { ...DEFAULT_SECURITY_HEADERS }
  if (input.headers === false) {
    headers = false
  } else if (input.headers) {
    const keyMap = new Map(Object.keys(headers).map((key) => [key.toLowerCase(), key]))
    for (const [key, value] of Object.entries(input.headers)) {
      if (value === undefined) continue
      const previousKey = keyMap.get(key.toLowerCase())
      if (previousKey && previousKey !== key) delete headers[previousKey]
      headers[key] = value
      keyMap.set(key.toLowerCase(), key)
    }
  }

  const trustedProxies = [...(input.trustedProxies ?? DEFAULT_HTTP_CONFIG.trustedProxies)]
  return {
    production,
    headers,
    bodyLimit,
    trustedProxies,
    proxyRules: compileProxyRules(trustedProxies),
    cookie: resolveCookieConfig(input.cookie === undefined ? {} : input.cookie, production),
    cors: input.cors === undefined ? DEFAULT_HTTP_CONFIG.cors : input.cors,
    csrf: input.csrf === undefined ? DEFAULT_HTTP_CONFIG.csrf : input.csrf,
    trailingSlash,
    caseSensitive,
    hosts: Array.isArray(input.hosts) ? [...input.hosts] : input.hosts,
    middleware: [...(input.middleware ?? DEFAULT_HTTP_CONFIG.middleware)],
  }
}

/**
 * Validates a body limit at the application or local policy boundary.
 *
 * @param value - Declared byte limit or false to disable limiting.
 * @throws If the value is not false or a non-negative safe integer.
 */
export function assertBodyLimit(value: number | false): void {
  if (value !== false && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('bodyLimit must be a non-negative safe integer or false.')
  }
}
