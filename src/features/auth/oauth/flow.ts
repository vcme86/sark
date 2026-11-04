/** OAuth endpoint responses, transaction cookies and application callbacks. */

import type { Context } from '../../../app/http/types'
import { HttpError } from '../../../http/error'
import { createAuthorizationUrl, exchangeAuthorizationCode } from './authorization'
import type { DiscoveryCache } from './client'
import { isAuthorizationFailure } from './error'
import {
  createClearTransactionCookie,
  createTransactionCookie,
  createTransactionState,
  verifyTransactionState,
} from './transaction'
import type { OAuthResult, ResolvedOAuthProvider } from './types'

/** Starts a signed transaction and redirects to the selected provider. */
export async function handleSignIn(
  provider: ResolvedOAuthProvider,
  ctx: Context,
  secret: string,
  production: boolean,
  discovery: DiscoveryCache,
): Promise<Response> {
  try {
    const transaction = await createTransactionState(provider)
    const url = await createAuthorizationUrl(provider, transaction, ctx.req.raw.signal, discovery)
    const cookie = await createTransactionCookie(provider, transaction, secret, production)
    ctx.header('Set-Cookie', cookie, { append: true })
    return ctx.redirect(url, 302)
  } catch (error) {
    return handleOAuthError(provider, ctx, error)
  }
}

/** Verifies the transaction, obtains the login result and calls the application. */
export async function handleCallback(
  provider: ResolvedOAuthProvider,
  ctx: Context,
  secret: string,
  discovery: DiscoveryCache,
): Promise<Response> {
  ctx.header('Set-Cookie', createClearTransactionCookie(provider), { append: true })
  let result: OAuthResult
  try {
    const transaction = await verifyTransactionState(ctx.req.header('cookie'), provider, secret)
    result = await exchangeAuthorizationCode(provider, ctx.req.raw, transaction, discovery)
  } catch (error) {
    return handleOAuthError(provider, ctx, error)
  }
  // Application failures belong to the HTTP boundary, not the OAuth error callback.
  const response = await provider.onSuccess(result.profile, result.tokens, ctx)
  return response ?? new Response(null, { status: 204 })
}

async function handleOAuthError(
  provider: ResolvedOAuthProvider,
  ctx: Context,
  error: unknown,
): Promise<Response> {
  if (provider.onError) {
    const response = await provider.onError(error, ctx)
    return response ?? new Response(null, { status: 204 })
  }
  if (isAuthorizationFailure(error)) {
    throw new HttpError(401, 'OAuth authorization failed', { code: 'oauth_failed' })
  }
  throw error
}
