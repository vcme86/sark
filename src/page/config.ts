/**
 * Page configuration declaration and factory wrappers.
 *
 * @module
 */

import { evaluateDeclaration, type RequiresEnv } from '../app/declaration'
import type { DefaultApi } from '../client/client'
import { DEFAULT_CLIENT_CREDENTIALS } from '../http/defaults'
import type { PageConfig, PageDeclaration } from './types'

/**
 * Declares static application page settings.
 *
 * @param config - Page transport and request identity settings.
 * @returns Wrapped page declaration used in application assembly.
 */
export function definePage<Api = DefaultApi>(config: PageConfig<Api>): PageDeclaration<Api>
/**
 * Declares page settings resolved from the owning host's environment.
 *
 * @param factory - Evaluated at Node creation or for the current Workers event.
 * @returns A declaration retaining its environment requirement.
 */
export function definePage<Env, Api = DefaultApi>(
  factory: (env: Env) => PageConfig<Api>,
): PageDeclaration<Api> & RequiresEnv<Env>
export function definePage<Env = unknown, Api = DefaultApi>(
  input: PageConfig<Api> | ((env: Env) => PageConfig<Api>),
): PageDeclaration<Api> {
  return {
    kind: 'page',
    value: input,
    isFactory: typeof input === 'function',
  }
}

/** Page configuration with transport defaults applied by its owning entry. */
export interface ResolvedPageConfig<Api = DefaultApi> {
  readonly api: {
    readonly serverUrl?: string
    readonly browserUrl?: string
    readonly credentials: RequestCredentials
  }
  readonly identity?: PageConfig<Api>['identity']
}

/**
 * Creates one application's page resolver, reusing only environment-independent settings.
 * Configuration factories still execute once for each external Workers event.
 *
 * @param declaration - Optional static settings or environment factory.
 * @param apiPrefix - Resolved engineering API prefix.
 * @returns A resolver owned by one application instance or Workers runtime.
 */
export function createPageConfigResolver<Api = DefaultApi>(
  declaration: PageDeclaration<Api> | undefined,
  apiPrefix: string,
): (env: unknown) => ResolvedPageConfig<Api> {
  let staticConfig: ResolvedPageConfig<Api> | undefined
  return (env) =>
    declaration?.isFactory
      ? resolvePageConfig(declaration, env, apiPrefix)
      : (staticConfig ??= resolvePageConfig(declaration, env, apiPrefix))
}

/**
 * Resolves page settings at Node instance creation or for the current Workers event.
 * Identity remains a request callback and is not evaluated here.
 *
 * @param declaration - Optional static settings or environment factory.
 * @param env - Environment supplied by the owning host.
 * @param apiPrefix - Complete engineering API prefix for the local browser transport.
 * @returns Page settings with explicit browser transport defaults.
 * @throws {Error} If a declaration or its transport settings are invalid.
 */
export function resolvePageConfig<Env = unknown, Api = DefaultApi>(
  declaration: PageDeclaration<Api> | undefined,
  env: Env,
  apiPrefix: string,
): ResolvedPageConfig<Api> {
  const rawConfig = declaration ? evaluateDeclaration(declaration.value, env, 'page') : {}

  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('Page configuration must be an object.')
  }
  const api = rawConfig.api
  if (api !== undefined) {
    if (!api || typeof api !== 'object' || Array.isArray(api)) {
      throw new Error('page.api must be an object.')
    }
    validateApiBase(api.serverUrl, 'serverUrl', false)
  }
  const browserUrl = api?.browserUrl
  if (browserUrl !== undefined) validateApiBase(browserUrl, 'browserUrl', true)
  const credentials = api?.credentials === undefined ? DEFAULT_CLIENT_CREDENTIALS : api.credentials
  if (credentials !== 'same-origin' && credentials !== 'include' && credentials !== 'omit') {
    throw new Error('page.api.credentials must be same-origin, include, or omit.')
  }
  if (rawConfig.identity !== undefined && typeof rawConfig.identity !== 'function') {
    throw new Error('page.identity must be a function.')
  }
  return {
    api: {
      serverUrl: api?.serverUrl,
      browserUrl: browserUrl === apiPrefix ? undefined : browserUrl,
      credentials,
    },
    identity: rawConfig.identity,
  }
}

function validateApiBase(
  value: unknown,
  field: string,
  allowRelative: boolean,
): asserts value is string {
  let url: URL
  try {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Missing URL')
    url = new URL(value, allowRelative ? 'http://page.local/' : undefined)
  } catch {
    throw new Error(
      `page.api.${field} must be ${allowRelative ? 'a URL or path' : 'an HTTP(S) URL'}.`,
    )
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    /[?#]/.test(value) ||
    url.username ||
    url.password
  ) {
    throw new Error(`page.api.${field} must use HTTP(S) without query, fragment, or credentials.`)
  }
}
