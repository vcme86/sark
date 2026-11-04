/** Standard OIDC profile retrieval and normalization after ID Token validation. */
import { type Configuration, fetchUserInfo, type IDToken } from 'openid-client'

import type { UserProfile } from '../../contracts'
import type { ResolvedOAuthProvider } from '../types'

/** Fetches applicable UserInfo through the SDK, including its subject binding checks. */
export async function fetchOidcProfile(
  provider: ResolvedOAuthProvider,
  config: Configuration,
  accessToken: string,
  claims: IDToken,
): Promise<UserProfile> {
  const userinfo = config.serverMetadata().userinfo_endpoint
    ? await fetchUserInfo(config, accessToken, claims.sub)
    : undefined
  const email = stringClaim(claims.email) ?? stringClaim(userinfo?.email)
  // Verification applies to the selected address, not to the profile as a whole.
  const emailVerified =
    email === undefined
      ? undefined
      : ((claims.email === email ? booleanClaim(claims.email_verified) : undefined) ??
        (userinfo?.email === email ? booleanClaim(userinfo.email_verified) : undefined))
  return {
    provider: provider.id,
    subject: claims.sub,
    issuer: claims.iss,
    email,
    emailVerified,
    name: stringClaim(claims.name) ?? stringClaim(userinfo?.name),
    picture: stringClaim(claims.picture) ?? stringClaim(userinfo?.picture),
    raw: { claims, userinfo },
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function booleanClaim(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
