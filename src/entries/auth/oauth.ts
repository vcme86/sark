/**
 * Third-party OAuth 2.0 and OIDC authentication entrypoint for Sark applications.
 *
 * @module
 */

export { defineOAuth } from '../../services/auth/oauth/config'
export type {
  OAuthDeclaration,
  OAuthProviderConfig,
  OAuthProviderKind,
} from '../../services/auth/oauth/types'
export type { OAuthTokens, UserProfile } from '../../services/auth/contracts'
