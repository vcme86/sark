/**
 * GitHub OAuth 2.0 user profile and email retrieval.
 *
 * @module
 */

import type { UserProfile } from '../../contracts'
import type { ResolvedOAuthProvider } from '../types'

interface GitHubUser {
  readonly id: number
  readonly login: string
  readonly name?: string | null
  readonly email?: string | null
  readonly avatar_url?: string
}

interface GitHubEmail {
  readonly email: string
  readonly primary: boolean
  readonly verified: boolean
}

/**
 * Fetches user profile and email details from GitHub API endpoints.
 *
 * @param provider - Owning GitHub provider configuration.
 * @param accessToken - Valid GitHub access token.
 * @param signal - Request cancellation signal.
 * @returns The provider-namespaced user profile.
 */
export async function fetchGitHubProfile(
  provider: ResolvedOAuthProvider,
  accessToken: string,
  signal?: AbortSignal,
): Promise<UserProfile> {
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'sark',
    },
    signal,
  })

  if (!userRes.ok) {
    throw new Error(`GitHub user API returned HTTP ${userRes.status}`)
  }

  const userJson = (await userRes.json()) as GitHubUser
  if (!userJson || typeof userJson.id !== 'number') {
    throw new Error('GitHub user API response missing user id.')
  }

  const email = userJson.email ? undefined : await fetchGitHubEmail(accessToken, signal)

  return {
    provider: provider.id,
    subject: String(userJson.id),
    email: email?.email ?? userJson.email ?? undefined,
    emailVerified: email?.verified,
    name: userJson.name ?? userJson.login,
    picture: userJson.avatar_url,
    raw: userJson,
  }
}

/** Retrieves optional email details; transport cancellation still stops the login flow. */
async function fetchGitHubEmail(
  accessToken: string,
  signal?: AbortSignal,
): Promise<GitHubEmail | undefined> {
  try {
    const response = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'sark' },
      signal,
    })
    if (!response.ok) return undefined
    const emails = (await response.json()) as GitHubEmail[]
    if (!Array.isArray(emails)) return undefined
    return (
      emails.find((email) => email.primary && email.verified) ??
      emails.find((email) => email.verified) ??
      emails[0]
    )
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}
