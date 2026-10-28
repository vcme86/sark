import { type CorsOptions, type ResolvedHttpConfig, resolveHttpConfig } from '../http/config'
import type { MiddlewareHandler } from '../http/types'
import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from './declaration'

/** Core application configuration. */
export interface AppConfig {
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

/** Declaration representation for the core application configuration. */
export interface AppDeclaration extends BaseDeclaration<'app', AppConfig> {}

/**
 * Declares top-level core application configuration in `app.ts`.
 * Accepts a static `AppConfig` object or a factory receiving the environment.
 *
 * @param config - Core HTTP configuration. Omitted fields use framework defaults.
 * @returns A configuration declaration; application creation resolves its defaults.
 *
 * @example
 * ```ts
 * export const app = defineApp({
 *   bodyLimit: 2 * 1024 * 1024,
 *   cors: { origin: 'https://example.com', credentials: true },
 * })
 * ```
 */
export function defineApp(config?: AppConfig): AppDeclaration
/**
 * Declares core configuration resolved from the application's environment.
 *
 * @param factory - Evaluated at creation for Node applications, or per event for Workers;
 *   discovery does not execute it.
 * @returns A declaration preserving the factory's environment requirement.
 */
export function defineApp<E>(factory: (env: E) => AppConfig): AppDeclaration & RequiresEnv<E>
export function defineApp<E>(input?: AppConfig | ((env: E) => AppConfig)): AppDeclaration {
  return {
    kind: 'app',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Evaluates an application declaration and resolves its HTTP configuration.
 *
 * @param declaration - Optional static declaration or environment factory.
 * @param env - Environment supplied by the owning host or event.
 * @param production - Production mode supplied by that host.
 * @returns Complete configuration for this instance or event.
 * @throws If a factory has no environment or does not return an options object.
 */
export function resolveAppConfig(
  declaration: AppDeclaration | undefined,
  env: unknown,
  production: boolean,
): ResolvedHttpConfig {
  const input = declaration ? evaluateDeclaration(declaration.value, env, 'app') : {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Application configuration must be an object.')
  }
  return resolveHttpConfig(input, production)
}
