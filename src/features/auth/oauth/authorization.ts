/** Authorization requests and code exchange, independent of HTTP application callbacks. */
import * as oidc from 'openid-client'

import type { OAuthTokens } from '../contracts'
import { type DiscoveryCache, getOidcClientConfig } from './client'
import { readAppleProfile } from './providers/apple'
import { fetchGitHubProfile } from './providers/github'
import { fetchOidcProfile } from './providers/oidc'
import { buildWeChatAuthorizationUrl, exchangeWeChatCode } from './providers/wechat'
import type { OAuthTransactionState } from './transaction'
import type { OAuthResult, ResolvedOAuthProvider } from './types'

/** Builds the selected provider's authorization URL from a prepared transaction. */
export async function createAuthorizationUrl(
  provider: ResolvedOAuthProvider,
  transaction: OAuthTransactionState,
  signal: AbortSignal,
  discovery: DiscoveryCache,
): Promise<string> {
  if (provider.kind === 'wechat') return buildWeChatAuthorizationUrl(provider, transaction.state)
  const config = await getOidcClientConfig(provider, signal, undefined, discovery)
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: transaction.redirectUri,
    scope: provider.scopes.join(' '),
    state: transaction.state,
    ...(transaction.codeChallenge
      ? { code_challenge: transaction.codeChallenge, code_challenge_method: 'S256' }
      : {}),
    ...(transaction.nonce ? { nonce: transaction.nonce } : {}),
    ...(provider.callbackMethod === 'POST' ? { response_mode: 'form_post' } : {}),
  }).href
}

/** Validates the authorization response and returns provider-namespaced credentials and profile. */
export async function exchangeAuthorizationCode(
  provider: ResolvedOAuthProvider,
  request: Request,
  transaction: OAuthTransactionState,
  discovery: DiscoveryCache,
): Promise<OAuthResult> {
  if (provider.kind === 'wechat') return exchangeWeChatCode(provider, request, transaction.state)

  const config = await getOidcClientConfig(
    provider,
    request.signal,
    transaction.redirectUri,
    discovery,
  )
  const callback = publicCallback(request, transaction.redirectUri)
  const tokenSet = await oidc.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: transaction.codeVerifier,
    expectedState: transaction.state,
    ...(provider.protocol === 'oidc'
      ? { expectedNonce: transaction.nonce, idTokenExpected: true }
      : {}),
  })
  const tokens = mapTokens(tokenSet)
  switch (provider.kind) {
    case 'github':
      return {
        tokens,
        profile: await fetchGitHubProfile(provider, tokenSet.access_token, request.signal),
      }
    case 'apple':
      return { tokens, profile: await readAppleProfile(provider, request, tokenSet.claims()!) }
    default:
      return {
        tokens,
        profile: await fetchOidcProfile(
          provider,
          config,
          tokenSet.access_token,
          tokenSet.claims()!,
        ),
      }
  }
}

/** Restores the registered public origin/path while preserving incoming protocol parameters. */
function publicCallback(request: Request, redirectUri: string): URL | Request {
  const registered = new URL(redirectUri)
  const url = new URL(request.url)
  url.protocol = registered.protocol
  url.host = registered.host
  url.pathname = registered.pathname
  // The SDK must receive the actual form_post body, not only its URL.
  return request.method === 'POST' ? new Request(url, request.clone()) : url
}

function mapTokens(tokenSet: oidc.TokenEndpointResponse): OAuthTokens {
  return {
    accessToken: tokenSet.access_token,
    refreshToken: tokenSet.refresh_token,
    expiresAt:
      tokenSet.expires_in === undefined
        ? undefined
        : Math.floor(Date.now() / 1000) + tokenSet.expires_in,
    tokenType: tokenSet.token_type,
    scope: tokenSet.scope,
    idToken: tokenSet.id_token,
  }
}
