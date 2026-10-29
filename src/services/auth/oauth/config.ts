/**
 * OAuth provider declaration and configuration resolution.
 *
 * @module
 */

import { evaluateDeclaration, type RequiresEnv } from '../../../core/declaration'
import { resolveStaticPath } from '../../../http/url'
import { normalizePresetConfig } from './providers/presets'
import type {
  OAuthDeclaration,
  OAuthInput,
  OAuthProviderConfig,
  ResolvedOAuthProvider,
} from './types'

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

export function defineOAuth(input: OAuthInput): OAuthDeclaration {
  return {
    kind: 'oauth',
    value: input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves declared OAuth configurations into fully validated ResolvedOAuthProvider objects.
 *
 * @param input - Provider array or configuration factory.
 * @param env - Current instance or event environment.
 * @param apiPrefix - Resolved engineering API prefix for default authorization endpoints.
 * @returns Fully validated and normalized array of ResolvedOAuthProvider.
 * @throws If credentials or path configurations are invalid.
 */
export function resolveOAuthProviders(
  input: OAuthInput,
  env: unknown,
  apiPrefix: string,
): readonly ResolvedOAuthProvider[] {
  const list = evaluateDeclaration(input, env, 'OAuth')

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
      `OAuth provider "${raw.id}" signInPath`,
    )
    const callbackPath = resolveStaticPath(
      raw.callbackPath ?? parsedRedirectUri.pathname,
      `OAuth provider "${raw.id}" callbackPath`,
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
