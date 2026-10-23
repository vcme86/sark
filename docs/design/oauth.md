# 第三方登录：OAuth 2.0 与 OIDC

## 上游和职责

标准发现、授权请求、回调校验、换码、客户端认证、ID Token/UserInfo 的适用校验由 openid-client 承担。Sark 完成配置、事务 Cookie、开发生产接入、厂商差异和应用回调。

账户关联、角色、登录 UI、第三方长期令牌保存和后续 API 调用属于应用。启用 OAuth 不强制启用第一方 session、数据库或 MFA；回调可以按应用用途接入它们。

## 声明

```ts
import { defineOAuth } from '@olivaw/sark/auth/oauth'

type Env = NodeJS.ProcessEnv

export const oauth = defineOAuth((env: Env) => {
  const clientId = env.GOOGLE_ID
  const clientSecret = env.GOOGLE_SECRET
  if (!clientId || !clientSecret) throw new Error('Google OAuth credentials are required')
  return [
    {
      id: 'google',
      kind: 'oidc',
      issuer: 'https://accounts.google.com',
      clientId,
      clientSecret,
      scopes: ['openid', 'email', 'profile'],
      redirectUri: 'https://app.example.com/auth/google/callback',
      onSuccess: async (profile, tokens, ctx) => {
        const identity = await mapExternalAccount(profile, ctx.var.db)
        await ctx.var.auth.signIn(identity)
        return ctx.redirect('/dashboard')
      },
    },
  ]
})
```

这是 Node 工厂示例，Workers 沿 [application.md](application.md) 使用 Wrangler Env；类型声明不保证环境值存在。mapExternalAccount 是应用逻辑；例中使用 db/auth 才声明相应能力。提供方列表固定在声明中，凭据在工厂解析。缺少必需配置在协议处理前拒绝，不启动配置不完整的提供方。

```ts
interface OAuthProviderConfig {
  id: string
  kind: 'oidc' | 'github' | 'microsoft' | 'apple' | 'wechat'
  issuer?: string
  clientId: string
  clientSecret?: string
  scopes: string[]
  redirectUri: string
  onSuccess: (
    profile: UserProfile,
    tokens: OAuthTokens,
    ctx: Context,
  ) => Response | void | Promise<Response | void>
  onError?: (error: unknown, ctx: Context) => Response | void | Promise<Response | void>
}
```

id 唯一，用于入口和状态名；scopes 无默认值，OIDC 必须含 openid。redirectUri 为注册的公开回调地址，不从不可信 Host 临时生成。公开客户端的 clientSecret 是否可省由协议与提供方配置决定。

onSuccess 返回 Response 时直接使用该响应，void 返回 204，不替应用选择页面。onError 默认 401；应用可明确返回自己的响应，void 同样为空响应。回调拿实际 Hono Context 与已声明资源，不能用全量 AppInstance 反推配置类型。

## 协议区别

OIDC 使用发现元数据与 ID Token，按实际流程校验 issuer、audience、期限及已发送 nonce；UserInfo subject 与认证结果按标准绑定。纯 OAuth（例如 GitHub）没有 ID Token/nonce/JWKS，走提供方资料端点，不能被强制套 OIDC scope。

Sark 不另写一套 JWT/JWKS 检查；openid-client 按选定流程落实标准。通过受信 HTTPS Token Endpoint 得到的授权码响应，可按 OIDC 明确条件使用 TLS 验证；需要 ID Token 签名校验的流程必须验签，JWKS 失败不能降级。[OIDC ID Token 校验](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)、[openid-client](https://github.com/panva/openid-client)

提供方差异集中在适配器：GitHub 用户和邮箱接口，Microsoft 租户/资料，Apple form_post 与 client secret JWT，微信非标准授权/资料。其余初始化、取消和错误沿共同流程，不各建一套 OAuth 引擎。

## 入口与事务 Cookie

提供 GET /auth/:id/login，以及具体提供方所需的 /auth/:id/callback GET/POST。实际占用的方法和路径参与冲突检查。

登录入口生成 state、PKCE verifier，OIDC 同时生成 nonce，再经上游构造授权 URL。事务值保存在服务端签名的短期 Cookie，内容绑定提供方、用途、创建/过期时间与注册回调。密钥来自显式 app.cookie.secret，不复用 JWT 密钥；启用却缺密钥在资源创建前拒绝。

状态 Cookie 默认十分钟、HttpOnly、回调相关 Path，每个提供方独立命名；重新发起同一提供方登录替换其未完成事务。标准 GET 回调采用 Lax；跨站 form_post 的提供方采用 SameSite=None; Secure。属性不同不影响第一方会话 Cookie。

回调先验证 Cookie 完整性、期限、提供方和适用方法，再将 state/nonce/verifier 交给 openid-client 完成回调与换码，处理后清理事务 Cookie。请求中的协议错误也交给 onError 处理。

事务 Cookie 不维护跨实例的一次性消费状态。授权码由提供方保证单次使用；框架不为 state 另建数据库式原子消费记录，也不因此强制引入 MFA 状态表。

OAuth 回调仅在该协议端点使用事务验证替代普通业务来源规则；不把例外扩展到其他表单，CORS 放行不替代 state。

## 资料与令牌

```ts
interface UserProfile {
  provider: string
  subject: string
  issuer?: string
  email?: string
  emailVerified?: boolean
  name?: string
  picture?: string
  raw: unknown
}

interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType?: string
  scope?: string
  idToken?: string
}
```

账户键至少保留提供方/issuer 与其 subject 的命名空间，不能仅把不同 IdP 的 sub 当全局账号。email 可能缺失，是否关联已有账户由应用评估，框架不按邮箱自动合并。

expiresAt 为 Unix 秒；缺 refreshToken 就保持缺失，不伪造。tokens 只传给服务端回调，不自动保存、刷新或进入浏览器载荷。应用需要调用第三方 API 时自行选择持久化与刷新策略。

## Node、Workers 与 MFA 的衔接

Node 和 Workers 使用相同协议与 Cookie 行为，资源和秘密来自所属环境，外部请求传递取消信号。多实例只需正确共享配置/密钥与应用所用数据，不依赖某个实例内的 OAuth 事务 Map。

应用可在映射账户后调用 ctx.var.mfa.beginLogin，而不是先签发完整 session 再要求第二步。OAuth 成功不自动证明完成本地 TOTP；是否采信第三方提供的认证方式和验证结果，由应用按其信任策略决定。

本模块是第三方认证的客户端，不提供 OIDC Provider。远期站点身份联邦不改变当前模块职责，也不提前创建供应方服务。

## 验证

用协议夹具验证真实回调、scope/nonce/PKCE、GET/form_post Cookie、错误和令牌交付；分别验证 Node/Workers 打包与请求链路。厂商真实联调有相应凭据前提，不能把静态示例称为全部厂商联调完成。
