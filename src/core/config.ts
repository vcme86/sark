import {
  type CorsOptions,
  DEFAULT_HTTP_CONFIG,
  DEFAULT_SECURITY_HEADERS,
  type HttpConfig,
  type ResolvedHttpConfig,
  resolveHttpConfig,
} from '../web/http/config'
import type { BaseDeclaration, RequiresEnv } from './declaration'

/** Top-level application configuration type, alias of `HttpConfig`. */
export type AppConfig = HttpConfig
export type { CorsOptions }
export { DEFAULT_HTTP_CONFIG as DEFAULT_APP_CONFIG, DEFAULT_SECURITY_HEADERS, resolveHttpConfig }

/** Declaration representation for the core application configuration. */
export interface AppDeclaration extends BaseDeclaration<'app', AppConfig> {}

/**
 * Declares top-level core application configuration in `app.ts`.
 * Accepts a static `AppConfig` object or a factory receiving the environment.
 *
 * @param options - Core HTTP configuration. Omitted fields use framework defaults.
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
export function defineApp(options?: AppConfig): AppDeclaration
/**
 * Declares core configuration resolved from the application's environment.
 *
 * @param factory - Evaluated at creation for Node applications, or per event for Workers;
 *   discovery does not execute it.
 * @returns A declaration preserving the factory's environment requirement.
 */
export function defineApp<E>(factory: (env: E) => AppConfig): AppDeclaration & RequiresEnv<E>
export function defineApp<E>(
  input?: AppConfig | ((env: E) => AppConfig),
): AppDeclaration & RequiresEnv<E> {
  return {
    kind: 'app',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  } as AppDeclaration & RequiresEnv<E>
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
  let input: AppConfig = {}
  if (declaration) {
    if (typeof declaration.value === 'function') {
      if (env === undefined)
        throw new Error(
          'Environment required by app declaration factory was not provided to createApp.',
        )
      input = declaration.value(env)
    } else input = declaration.value
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Application configuration must be an object.')
    }
  }
  return resolveHttpConfig(input, production)
}
