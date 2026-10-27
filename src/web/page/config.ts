/**
 * Page configuration declaration and factory wrappers.
 *
 * @module
 */

import type { RequiresEnv } from '../../core/declaration'
import type { DefaultApi } from '../http/client/client'
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
  config: PageConfig<Api> | ((env: Env) => PageConfig<Api>),
): PageDeclaration<Api> & (unknown extends Env ? {} : RequiresEnv<Env>) {
  return {
    kind: 'page',
    isFactory: typeof config === 'function',
    value: config,
  } as PageDeclaration<Api> & (unknown extends Env ? {} : RequiresEnv<Env>)
}

/** Page configuration with transport defaults applied by its owning entry. */
export interface ResolvedPageConfig<Api = DefaultApi> {
  readonly api: {
    readonly serverUrl?: string
    readonly browserUrl: string
    readonly credentials: RequestCredentials
  }
  readonly identity?: PageConfig<Api>['identity']
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
  const rawConfig = declaration
    ? declaration.isFactory
      ? (declaration.value as (env: Env) => PageConfig<Api>)(env)
      : (declaration.value as PageConfig<Api>)
    : {}

  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('Page configuration must be an object.')
  }
  const api = rawConfig.api
  if (api !== undefined) {
    if (!api || typeof api !== 'object' || Array.isArray(api)) {
      throw new Error('page.api must be an object.')
    }
    if (typeof api.serverUrl !== 'string' || !api.serverUrl) {
      throw new Error('page.api.serverUrl is required for remote transport.')
    }
    const target = new URL(api.serverUrl)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('page.api.serverUrl must be an HTTP(S) URL.')
    }
  }
  const browserUrl = api?.browserUrl === undefined ? apiPrefix : api.browserUrl
  if (typeof browserUrl !== 'string' || !browserUrl.trim()) {
    throw new Error('page.api.browserUrl must be a non-empty URL or path.')
  }
  const credentials = api?.credentials === undefined ? DEFAULT_CLIENT_CREDENTIALS : api.credentials
  if (credentials !== 'same-origin' && credentials !== 'include' && credentials !== 'omit') {
    throw new Error('page.api.credentials must be same-origin, include, or omit.')
  }
  if (rawConfig.identity !== undefined && typeof rawConfig.identity !== 'function') {
    throw new Error('page.identity must be a function.')
  }
  return {
    api: { serverUrl: api?.serverUrl, browserUrl, credentials },
    identity: rawConfig.identity,
  }
}
