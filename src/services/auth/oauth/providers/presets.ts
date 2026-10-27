/** Fixed provider information and constraints resolved at configuration entry. */
import type { OAuthProviderConfig, ResolvedOAuthProvider } from '../types'

export const GOOGLE_ISSUER = 'https://accounts.google.com'
export const APPLE_ISSUER = 'https://appleid.apple.com'
export const MICROSOFT_DEFAULT_ISSUER = 'https://login.microsoftonline.com/common/v2.0'

/** Resolves vendor defaults without duplicating discovery or protocol processing. */
export function normalizePresetConfig(
  provider: OAuthProviderConfig,
): Pick<ResolvedOAuthProvider, 'issuer' | 'protocol' | 'callbackMethod' | 'pkce'> {
  if ((provider.kind === 'github' || provider.kind === 'apple') && !provider.clientSecret) {
    throw new Error(
      `OAuth provider "${provider.id}" requires clientSecret for its authorization-code flow.`,
    )
  }
  let issuer: string
  let protocol: ResolvedOAuthProvider['protocol'] = 'oidc'
  switch (provider.kind) {
    case 'google':
      if (provider.issuer !== undefined)
        throw new Error('Google preset does not accept an issuer override.')
      issuer = GOOGLE_ISSUER
      break
    case 'apple':
      issuer = provider.issuer ?? APPLE_ISSUER
      break
    case 'microsoft':
      issuer = provider.issuer ?? MICROSOFT_DEFAULT_ISSUER
      break
    case 'oidc':
      if (!provider.issuer)
        throw new Error(`OIDC provider "${provider.id}" requires an issuer URL.`)
      issuer = provider.issuer
      break
    case 'github':
      issuer = 'https://github.com'
      protocol = 'oauth'
      break
    case 'wechat':
      if (!provider.clientSecret)
        throw new Error(`WeChat provider "${provider.id}" requires clientSecret.`)
      issuer = 'https://open.weixin.qq.com'
      protocol = 'wechat'
      break
    default:
      throw new Error(`Unsupported OAuth provider kind: "${provider.kind}"`)
  }
  if (protocol === 'oidc' && provider.kind !== 'apple' && !provider.scopes.includes('openid')) {
    throw new Error(`OIDC provider "${provider.id}" requires "openid" in scopes.`)
  }
  if (protocol === 'oidc' && new URL(issuer).protocol !== 'https:') {
    throw new Error(`OIDC provider "${provider.id}" issuer must use HTTPS.`)
  }
  return {
    issuer,
    protocol,
    callbackMethod: provider.kind === 'apple' ? 'POST' : 'GET',
    pkce: protocol !== 'wechat' && provider.kind !== 'apple',
  }
}
