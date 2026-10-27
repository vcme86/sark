/** Request-local openid-client configuration with application-owned discovery metadata. */
import * as oidc from 'openid-client'

import type { ResolvedOAuthProvider } from './types'

interface DiscoveryDocument {
  readonly url: string
  readonly body: string
  readonly expiresAt: number
}

/** Successful discovery documents only; no credentials, bindings or request signals. */
export type DiscoveryCache = Map<string, DiscoveryDocument>

/** Preserves the exact registered redirect URI and propagates request cancellation. */
export function createCustomFetch(
  tokenEndpoint?: string,
  expectedRedirectUri?: string,
  requestSignal?: AbortSignal,
): oidc.CustomFetch {
  return (url, init) => {
    let body = init.body
    if (
      expectedRedirectUri &&
      String(url) === tokenEndpoint &&
      init.method === 'POST' &&
      body instanceof URLSearchParams &&
      body.get('grant_type') === 'authorization_code' &&
      body.get('redirect_uri') !== expectedRedirectUri
    ) {
      body = new URLSearchParams(body)
      body.set('redirect_uri', expectedRedirectUri)
    }
    const signal = requestSignal
      ? init.signal
        ? AbortSignal.any([init.signal, requestSignal])
        : requestSignal
      : init.signal
    return fetch(url, { ...init, body: body as BodyInit, signal })
  }
}

/** Creates a client for this request while retaining upstream discovery extensions. */
export async function getOidcClientConfig(
  provider: ResolvedOAuthProvider,
  requestSignal?: AbortSignal,
  expectedRedirectUri?: string,
  cache?: DiscoveryCache,
): Promise<oidc.Configuration> {
  const authenticate: oidc.ClientAuth = (server, client, body, headers) => {
    if (!provider.clientSecret) return oidc.None()(server, client, body, headers)
    const methods = server.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
    const method = methods.includes('client_secret_basic')
      ? oidc.ClientSecretBasic(provider.clientSecret)
      : methods.includes('client_secret_post')
        ? oidc.ClientSecretPost(provider.clientSecret)
        : undefined
    if (!method)
      throw new Error(
        `OAuth provider "${provider.id}" does not support client secret authentication.`,
      )
    return method(server, client, body, headers)
  }

  let config: oidc.Configuration
  if (provider.kind === 'github') {
    config = new oidc.Configuration(
      {
        issuer: provider.issuer,
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      },
      provider.clientId,
      provider.clientSecret,
      authenticate,
    )
  } else {
    const discoveryFetch: oidc.CustomFetch = async (url, init) => {
      requestSignal?.throwIfAborted()
      const cached = cache?.get(provider.id)
      if (cached?.url === String(url) && Date.now() < cached.expiresAt) {
        return new Response(cached.body, { headers: { 'Content-Type': 'application/json' } })
      }
      const response = await createCustomFetch(undefined, undefined, requestSignal)(url, init)
      if (response.ok && cache) {
        const body = await response.clone().text()
        // Entries are bounded by the active providers and refreshed after five minutes.
        cache.set(provider.id, { url: String(url), body, expiresAt: Date.now() + 300_000 })
      }
      return response
    }
    try {
      config = await oidc.discovery(
        new URL(provider.issuer),
        provider.clientId,
        provider.clientSecret,
        authenticate,
        {
          [oidc.customFetch]: discoveryFetch,
        },
      )
    } catch (error) {
      cache?.delete(provider.id)
      throw error
    }
  }
  config[oidc.customFetch] = createCustomFetch(
    config.serverMetadata().token_endpoint,
    expectedRedirectUri,
    requestSignal,
  )
  return config
}
