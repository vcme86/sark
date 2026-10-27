/**
 * WeChat OAuth 2.0 authorization, code exchange, and profile retrieval.
 *
 * @module
 */

import type { OAuthResult, ResolvedOAuthProvider } from '../types'

interface WeChatTokenResponse {
  readonly access_token?: string
  readonly openid?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly scope?: string
  readonly errcode?: number
  readonly errmsg?: string
}

interface WeChatUserInfo {
  readonly nickname?: string
  readonly headimgurl?: string
  readonly errcode?: number
}

/**
 * Builds the WeChat OAuth 2.0 authorization URL.
 *
 * @param provider - WeChat provider configuration.
 * @param state - Anti-CSRF transaction state.
 * @returns Authorization redirect URL string.
 */
export function buildWeChatAuthorizationUrl(
  provider: ResolvedOAuthProvider,
  state: string,
): string {
  const endpoint = provider.scopes.includes('snsapi_login') ? 'qrconnect' : 'oauth2/authorize'
  return `https://open.weixin.qq.com/connect/${endpoint}?appid=${encodeURIComponent(
    provider.clientId,
  )}&redirect_uri=${encodeURIComponent(provider.redirectUri)}&response_type=code&scope=${encodeURIComponent(
    provider.scopes.join(','),
  )}&state=${encodeURIComponent(state)}#wechat_redirect`
}

/**
 * Exchanges WeChat authorization code for access token and retrieves user info.
 *
 * @param provider - WeChat provider configuration.
 * @param request - Callback request containing the authorization code and state.
 * @param expectedState - State from the verified transaction cookie.
 * @returns Normalized UserProfile and OAuthTokens.
 */
export async function exchangeWeChatCode(
  provider: ResolvedOAuthProvider,
  request: Request,
  expectedState: string,
): Promise<OAuthResult> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  if (!code || url.searchParams.get('state') !== expectedState)
    throw new Error('Invalid WeChat authorization response.')
  const signal = request.signal
  const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(
    provider.clientId,
  )}&secret=${encodeURIComponent(provider.clientSecret!)}&code=${encodeURIComponent(
    code,
  )}&grant_type=authorization_code`

  const tokenRes = await fetch(tokenUrl, { signal })
  if (!tokenRes.ok) {
    throw new Error(`WeChat token exchange failed with HTTP ${tokenRes.status}`)
  }

  const tokenJson = (await tokenRes.json()) as WeChatTokenResponse
  if (tokenJson.errcode) {
    throw new Error(`WeChat token error: ${tokenJson.errmsg || tokenJson.errcode}`)
  }

  if (typeof tokenJson.access_token !== 'string' || typeof tokenJson.openid !== 'string') {
    throw new Error('WeChat token response is missing access_token or openid.')
  }
  const userInfo = provider.scopes.some(
    (scope) => scope === 'snsapi_userinfo' || scope === 'snsapi_login',
  )
    ? await fetchWeChatUserInfo(tokenJson.access_token, tokenJson.openid, signal)
    : {}

  return {
    profile: {
      provider: provider.id,
      subject: tokenJson.openid,
      name: userInfo.nickname,
      picture: userInfo.headimgurl,
      raw: { token: tokenJson, userInfo },
    },

    tokens: {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token,
      expiresAt: tokenJson.expires_in
        ? Math.floor(Date.now() / 1000) + tokenJson.expires_in
        : undefined,
      scope: tokenJson.scope,
      tokenType: 'Bearer',
    },
  }
}

/** Retrieves optional WeChat profile fields without changing the verified subject. */
async function fetchWeChatUserInfo(
  accessToken: string,
  subject: string,
  signal: AbortSignal,
): Promise<WeChatUserInfo> {
  const url = new URL('https://api.weixin.qq.com/sns/userinfo')
  url.search = new URLSearchParams({
    access_token: accessToken,
    openid: subject,
    lang: 'zh_CN',
  }).toString()
  const response = await fetch(url, { signal })
  if (!response.ok) return {}
  const profile = (await response.json()) as WeChatUserInfo
  return profile.errcode ? {} : profile
}
