/** Apple-specific form profile and non-standard claim normalization. */
import type { IDToken } from 'openid-client'

import type { UserProfile } from '../../contracts'
import type { ResolvedOAuthProvider } from '../types'

interface AppleUser {
  readonly name?: { readonly firstName?: unknown; readonly lastName?: unknown }
  readonly email?: unknown
}

/** Reads Apple's optional first-authorization profile after the SDK has verified the response. */
export async function readAppleProfile(
  provider: ResolvedOAuthProvider,
  request: Request,
  claims: IDToken,
): Promise<UserProfile> {
  const form = await request.clone().formData()
  const user = form.get('user')
  let profile: AppleUser | undefined
  if (typeof user === 'string') {
    try {
      profile = JSON.parse(user)
    } catch {
      // Apple sends this optional profile only on the first authorization.
    }
  }
  const name = [profile?.name?.firstName, profile?.name?.lastName]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .trim()
  const email =
    typeof claims.email === 'string'
      ? claims.email
      : typeof profile?.email === 'string'
        ? profile.email
        : undefined
  return {
    provider: provider.id,
    subject: claims.sub,
    issuer: claims.iss,
    name: name || (typeof claims.name === 'string' ? claims.name : undefined),
    email,
    emailVerified:
      email !== undefined && claims.email === email
        ? appleBooleanClaim(claims.email_verified)
        : undefined,
    picture: typeof claims.picture === 'string' ? claims.picture : undefined,
    raw: { claims, appleUser: user },
  }
}

function appleBooleanClaim(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}
