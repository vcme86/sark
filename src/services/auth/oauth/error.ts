/** OAuth authorization rejection classification without hiding transport or provider failures. */
import * as oidc from 'openid-client'

/** Expected rejection of an authorization response or transaction. */
export class OAuthAuthorizationError extends Error {
  override name = 'OAuthAuthorizationError'
}

const AUTHORIZATION_REJECTIONS = new Set([
  'access_denied',
  'user_cancelled_authorize',
  'login_required',
  'consent_required',
  'interaction_required',
  'account_selection_required',
])

const TOKEN_REJECTIONS = new Set([
  'invalid_grant',
  'invalid_token',
  'access_denied',
  'bad_verification_code',
])

const VALIDATION_FAILURES = new Set([
  'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
  'OAUTH_JWT_TIMESTAMP_CHECK_FAILED',
  'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED',
])

/**
 * Identifies transaction, credential, and protocol validation rejections.
 * Unknown errors, provider configuration faults, timeouts, and cancellation propagate.
 *
 * @param error - Failure returned by Sark's protocol checks or openid-client.
 * @returns Whether the default HTTP boundary should report an OAuth authorization failure.
 */
export function isAuthorizationFailure(error: unknown): boolean {
  if (error instanceof OAuthAuthorizationError) return true
  if (error instanceof oidc.AuthorizationResponseError) {
    return AUTHORIZATION_REJECTIONS.has(error.error)
  }
  if (error instanceof oidc.ResponseBodyError) {
    return error.status < 500 && TOKEN_REJECTIONS.has(error.error)
  }
  if (error instanceof oidc.WWWAuthenticateChallengeError) {
    return (
      error.status === 401 &&
      error.cause.some(
        (challenge) =>
          challenge.scheme === 'bearer' && challenge.parameters.error === 'invalid_token',
      )
    )
  }
  if (!(error instanceof oidc.ClientError)) return false
  if (VALIDATION_FAILURES.has(error.code ?? '')) return true
  // The SDK retains front-channel parameters in the processing error's cause.
  // Invalid token or userinfo response bodies are provider faults, not anonymous users.
  if (error.code === 'OAUTH_INVALID_RESPONSE' && error.cause instanceof Error) {
    const detail = error.cause.cause
    return (
      typeof detail === 'object' &&
      detail !== null &&
      'parameters' in detail &&
      detail.parameters instanceof URLSearchParams
    )
  }
  return false
}
