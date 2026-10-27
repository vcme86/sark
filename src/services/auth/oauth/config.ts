/**
 * OAuth provider declaration and configuration resolution.
 *
 * @module
 */

import type { RequiresEnv } from '../../../core/declaration'
import { normalizePresetConfig } from './providers/presets'
import type {
  OAuthDeclaration,
  OAuthInput,
  OAuthProviderConfig,
  ResolvedOAuthProvider,
} from './types'

/** Validates static endpoint paths and removes the matching key's trailing slash. */
function resolveStaticPath(path: string, fieldName: string, providerId: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(
      `OAuth provider "${providerId}" has invalid ${fieldName} "${path}": path must start with "/".`,
    )
  }
  if (path.includes('?') || path.includes('#')) {
    throw new Error(
      `OAuth provider "${providerId}" has invalid ${fieldName} "${path}": path cannot contain query or fragment.`,
    )
  }
  if (path.includes(':') || path.includes('*')) {
    throw new Error(
      `OAuth provider "${providerId}" has invalid ${fieldName} "${path}": path cannot contain parameters or wildcards.`,
    )
  }
  return path.length > 1 ? path.replace(/\/$/, '') : path
}

/**
 * Declares providers resolved from the current instance or event environment.
 *
 * @param factory - Returns the application's provider configurations.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineOAuth<E = unknown>(
  factory: (env: E) => readonly OAuthProviderConfig[],
): OAuthDeclaration & RequiresEnv<E>

/**
 * Declares statically configured third-party providers.
 *
 * @param providers - Explicit scopes, credentials, paths and application callbacks.
 * @returns The OAuth declaration consumed by generated assembly.
 */
export function defineOAuth(providers: readonly OAuthProviderConfig[]): OAuthDeclaration

export function defineOAuth(inputOrFactory: OAuthInput): OAuthDeclaration {
  return {
    kind: 'oauth',
    isFactory: typeof inputOrFactory === 'function',
    value: inputOrFactory,
  }
}

/**
 * Resolves declared OAuth configurations into fully validated ResolvedOAuthProvider objects.
 *
 * @param input - Declared provider array, declaration, or factory function.
 * @param env - Current instance or event environment.
 * @param apiPrefix - Resolved engineering API prefix for default authorization endpoints.
 * @returns Fully validated and normalized array of ResolvedOAuthProvider.
 * @throws If credentials or path configurations are invalid.
 */
export function resolveOAuthProviders(
  input: OAuthInput | OAuthDeclaration,
  env: unknown,
  apiPrefix: string,
): readonly ResolvedOAuthProvider[] {
  const actualInput =
    input && typeof input === 'object' && 'kind' in input && input.kind === 'oauth'
      ? (input as OAuthDeclaration).value
      : input

  let list: readonly OAuthProviderConfig[]
  if (typeof actualInput === 'function') {
    if (env === undefined) {
      throw new Error('Environment required by OAuth declaration factory was not provided.')
    }
    list = (actualInput as (env: any) => readonly OAuthProviderConfig[])(env)
  } else {
    list = actualInput as readonly OAuthProviderConfig[]
  }

  if (!Array.isArray(list)) {
    throw new Error('OAuth configuration must provide an array of providers.')
  }

  const seenIds = new Set<string>()
  const resolvedList: ResolvedOAuthProvider[] = []

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Each OAuth provider configuration must be an object.')
    }
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.id)) {
      throw new Error(
        'OAuth provider id is required and must contain only letters, digits, underscores or hyphens.',
      )
    }
    if (seenIds.has(raw.id)) {
      throw new Error(`Duplicate OAuth provider id: "${raw.id}".`)
    }
    seenIds.add(raw.id)

    if (!raw.clientId || typeof raw.clientId !== 'string') {
      throw new Error(`OAuth provider "${raw.id}" requires a non-empty clientId.`)
    }
    if (!raw.redirectUri || typeof raw.redirectUri !== 'string') {
      throw new Error(`OAuth provider "${raw.id}" requires a valid redirectUri.`)
    }

    let parsedRedirectUri: URL
    try {
      parsedRedirectUri = new URL(raw.redirectUri)
    } catch {
      throw new Error(`OAuth provider "${raw.id}" has invalid redirectUri "${raw.redirectUri}".`)
    }

    if (parsedRedirectUri.protocol !== 'http:' && parsedRedirectUri.protocol !== 'https:') {
      throw new Error(`OAuth provider "${raw.id}" redirectUri must use http or https protocol.`)
    }

    if (
      !Array.isArray(raw.scopes) ||
      raw.scopes.some((scope: unknown) => typeof scope !== 'string')
    ) {
      throw new Error(`OAuth provider "${raw.id}" requires a scopes array.`)
    }

    if (typeof raw.onSuccess !== 'function') {
      throw new Error(`OAuth provider "${raw.id}" requires an onSuccess callback function.`)
    }

    if (parsedRedirectUri.hash)
      throw new Error(`OAuth provider "${raw.id}" redirectUri must not contain a fragment.`)
    const preset = normalizePresetConfig(raw)

    const signInPath = resolveStaticPath(
      raw.signInPath ?? `${apiPrefix === '/' ? '' : apiPrefix}/auth/${raw.id}/signin`,
      'signInPath',
      raw.id,
    )
    const callbackPath = resolveStaticPath(
      raw.callbackPath ?? parsedRedirectUri.pathname,
      'callbackPath',
      raw.id,
    )

    resolvedList.push({
      ...raw,
      ...preset,
      cookiePath: parsedRedirectUri.pathname.replace(/\/$/, '') || '/',
      signInPath,
      callbackPath,
    })
  }

  return resolvedList
}
