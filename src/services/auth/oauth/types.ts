/**
 * Third-party OAuth 2.0 and OIDC configuration and declaration types.
 *
 * @module
 */

import type { BaseDeclaration } from '../../../core/declaration'
import type { SarkContext } from '../../../web/http/types'
import type { OAuthTokens, UserProfile } from '../contracts'

/** Supported OAuth provider presets and standard protocols. */
export type OAuthProviderKind = 'oidc' | 'apple' | 'google' | 'github' | 'microsoft' | 'wechat'

/** Application configuration for a third-party OAuth 2.0 or OIDC provider. */
export interface OAuthProviderConfig {
  /** Unique provider identifier used in route segments and state cookies. */
  readonly id: string
  /** Provider protocol kind or vendor preset. */
  readonly kind: OAuthProviderKind
  /** Required for 'oidc'; other OIDC presets supply a default, and Google rejects overrides. */
  readonly issuer?: string
  /** Registered client identifier. */
  readonly clientId: string
  /**
   * Client secret for confidential clients; required by GitHub, Apple, and WeChat.
   * Apple uses an application-generated client secret JWT.
   */
  readonly clientSecret?: string
  /** Explicit OAuth scopes; non-Apple OIDC providers require 'openid'. */
  readonly scopes: readonly string[]
  /**
   * Local authorization entrypoint path.
   * Defaults to `${apiPrefix}/auth/${id}/signin` (`/api/auth/${id}/signin` by default).
   */
  readonly signInPath?: string
  /**
   * Local callback path after any reverse-proxy path rewriting.
   * Defaults to `new URL(redirectUri).pathname`.
   */
  readonly callbackPath?: string
  /** Absolute public redirect URI registered with the external identity provider. */
  readonly redirectUri: string
  /**
   * Callback invoked after successful authorization and profile retrieval.
   * Returning a Response sends that response to the client; returning void responds with 204.
   *
   * @param profile - Provider-namespaced identity and profile fields.
   * @param tokens - Provider tokens for server-side application use.
   * @param ctx - Callback request context with the application's declared resources and services.
   * @returns An application response, or void for HTTP 204.
   */
  readonly onSuccess: (
    profile: UserProfile,
    tokens: OAuthTokens,
    ctx: SarkContext,
  ) => Response | void | Promise<Response | void>
  /**
   * Handles authorization or exchange failures; defaults to HTTP 401.
   * Exceptions from application callbacks propagate to the HTTP error boundary.
   *
   * @param error - Authorization, exchange, or provider profile failure.
   * @param ctx - Callback or authorization-entry request context.
   * @returns An application response, or void for HTTP 204.
   */
  readonly onError?: (
    error: unknown,
    ctx: SarkContext,
  ) => Response | void | Promise<Response | void>
}

/** Fully resolved OAuth provider with all paths and settings materialized. */
export interface ResolvedOAuthProvider extends OAuthProviderConfig {
  readonly signInPath: string
  readonly callbackPath: string
  readonly issuer: string
  readonly protocol: 'oidc' | 'oauth' | 'wechat'
  readonly pkce: boolean
  readonly callbackMethod: 'GET' | 'POST'
  readonly cookiePath: string
}

/** Normalized provider result delivered to the application's success callback. */
export interface OAuthResult {
  readonly profile: UserProfile
  readonly tokens: OAuthTokens
}

/** Configuration input for OAuth: static provider array or environment factory. */
export type OAuthInput =
  | readonly OAuthProviderConfig[]
  | ((env: any) => readonly OAuthProviderConfig[])

/** OAuth declaration retaining factory environment requirements. */
export interface OAuthDeclaration extends BaseDeclaration<
  'oauth',
  readonly OAuthProviderConfig[]
> {}
