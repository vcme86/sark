/**
 * Third-party OAuth 2.0 and OIDC authentication entrypoint for Sark applications.
 *
 * @module
 */

export { defineOAuth } from '../../features/auth/oauth/config'
export type {
  OAuthDeclaration,
  OAuthProviderConfig,
  OAuthProviderKind,
} from '../../features/auth/oauth/types'
export type { OAuthTokens, UserProfile } from '../../features/auth/contracts'
