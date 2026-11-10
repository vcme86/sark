# 第三方登录：OAuth 2.0 与 OIDC

## 上游和职责

标准发现、授权请求、回调校验、换码、客户端认证、ID Token/UserInfo 的适用校验由 openid-client 承担。Sark 完成配置、事务 Cookie、开发生产接入、厂商差异和应用回调。

账户关联、角色、登录 UI、第三方长期令牌保存和后续 API 调用属于应用。启用 OAuth 不强制启用第一方 session、数据库或 MFA；回调可以按应用用途接入它们。

## 声明

```ts
import { defineOAuth } from '@olivaw/sark/auth/oauth'

type Env = NodeJS.ProcessEnv

export const oauth = defineOAuth((env: Env) => [
  {
    id: 'google',
    kind: 'google',
    clientId: env.GOOGLE_ID,
    clientSecret: env.GOOGLE_SECRET,
    scopes: ['openid', 'email', 'profile'],
    redirectUri: 'https://app.example.com/api/auth/google/callback',
    onSuccess: async (profile, tokens, ctx) => {
      const identity = await mapExternalAccount(profile, ctx.var.db)
      await ctx.var.auth.signIn(identity)
      return ctx.redirect('/dashboard')
    },
  },
])
```

这是 Node 工厂示例，Workers 沿 [application.md](application.md) 使用 Wrangler Env；类型声明不保证环境值存在。mapExternalAccount 是应用逻辑；例中使用 db/auth 才声明相应能力。提供方列表固定在声明中，凭据在工厂解析。缺少必需配置在协议处理前拒绝，不启动配置不完整的提供方。

```ts
interface OAuthProviderConfig {
  id: string
  kind: 'oidc' | 'apple' | 'google' | 'github' | 'microsoft' | 'wechat'
  issuer?: string
  clientId: string | undefined
  clientSecret?: string
  scopes: string[]
  signInPath?: string
  callbackPath?: string
  redirectUri: string | undefined
  onSuccess: (
    profile: UserProfile,
    tokens: OAuthTokens,
    ctx: Context,
  ) => Response | void | Promise<Response | void>
  onError?: (error: unknown, ctx: Context) => Response | void | Promise<Response | void>
}
```

id 唯一，使用字母、数字、下划线或连字符，用于默认入口路径和状态名；scopes 无默认值，OIDC 必须含 openid。公开客户端的 clientSecret 是否可省由协议与提供方配置决定；GitHub 授权码流程和 Apple 必填，Apple 的值为应用生成的 client secret JWT。入口路径与 redirectUri 的规则见「入口路径与公开回调地址」。

google 预设内置 issuer `https://accounts.google.com`，通过标准发现取得端点，scopes 必须含 openid；应用无须填写 issuer，预设也不接受覆盖。自定义标准提供方使用 oidc，并显式提供 issuer。id 仍由应用选择，用于区分同一厂商的多个客户端配置。

onSuccess 返回 Response 时直接使用该响应，void 返回 204，不替应用选择页面。授权、换码或提供方资料处理失败进入应用配置的 onError；应用可明确返回自己的响应，void 同样为空响应。未配置 onError 时，事务失效、授权拒绝、无效授权码或令牌等预期认证拒绝返回 401 和共同错误信封，错误码 oauth_failed；发现、网络、超时、提供方故障或客户端配置故障向公共错误边界传播，保留原始异常或 cause，不转换为未登录。取消不触发自动重试。分类使用 SDK 错误类型、协议代码和厂商适配的已知拒绝码，不匹配异常消息。onSuccess/onError 抛出的应用异常沿公共 HTTP 错误边界处理，不转换为 OAuth 认证失败。回调拿实际 Hono Context 与已声明资源，不能用全量 AppInstance 反推配置类型。

clientId、redirectUri 等原始环境值由配置入口校验；条件必需的 issuer/clientSecret 同样按所选提供方验证。解析结果不向下游交付缺失凭据，不要求应用逐项检查框架配置。

## 协议区别

OIDC 使用发现元数据与 ID Token，按实际流程校验 issuer、audience、期限及已发送 nonce；UserInfo subject 与认证结果按标准绑定。纯 OAuth（例如 GitHub）没有 ID Token/nonce/JWKS，走提供方资料端点，不能被强制套 OIDC scope。

Sark 不另写一套 JWT/JWKS 检查；openid-client 按选定流程落实标准。通过受信 HTTPS Token Endpoint 得到的授权码响应，可按 OIDC 明确条件使用 TLS 验证；需要 ID Token 签名校验的流程必须验签，JWKS 失败不能降级。[OIDC ID Token 校验](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)、[openid-client](https://github.com/panva/openid-client)

提供方差异集中在适配器：GitHub 用户和邮箱接口，Microsoft 租户/资料，Apple form_post 与 client secret JWT，微信非标准授权/资料。其余初始化、取消和错误沿共同流程，不各建一套 OAuth 引擎。

Google、Microsoft、Apple 与通用 OIDC 使用标准发现；GitHub 使用固定的 OAuth 端点。厂商预设封装固定信息和必要差异，google 与通用 oidc 复用同一标准流程，不增加 SDK 或复制协议实现。配置解析、事务 Cookie、HTTP 路由及应用回调由共同流程负责，厂商适配不重复承担这些职责。

## 入口路径与公开回调地址

框架自动装配第三方授权的发起入口和回调，应用决定其挂载位置。发起入口使用 GET；回调方法由提供方流程确定，通常为 GET，Apple form_post 使用 POST。登录页面、登录后的去向及是否创建账号由应用决定。

- `signInPath`：本地授权发起路径，默认 `${apiPrefix}/auth/${id}/signin`；apiPrefix 默认 `/api`，设为 `/` 时不重复添加斜线。路径中的 signin 与 session 的 signIn/signOut 使用同一套术语
- `redirectUri`：必填的绝对 HTTP(S) 地址，与提供方登记的公开回调地址一致；不含 fragment，允许固定 query。不从请求 Host 推断，授权与换码使用同一完整值
- `callbackPath`：本地回调路径，默认取 redirectUri 的 pathname。公开地址经反向代理改写路径时，显式指定改写后的本地路径；代理映射由部署配置负责

例如 apiPrefix=`/api`、id=google、redirectUri=`https://app.example.com/api/auth/google/callback` 时，端点为 GET `/api/auth/google/signin` 和适用方法的 `/api/auth/google/callback`。apiPrefix=`/service/v2` 时，默认发起路径为 `/service/v2/auth/google/signin`；回调仍取显式登记的 redirectUri，不随前缀变化改写。

认证端点默认使用 API 命名空间，前端 `/auth` 等页面路径由应用组织；框架不提供登录页面，也不替应用注册第一方登录、退出或注册接口。

显式 signInPath/callbackPath 是以 `/` 开头的完整静态路径，不含 origin、query、fragment、路由参数或通配符；不再叠加 apiPrefix、webPrefix 或 Vite base。例如显式设置 `/account/google/signin` 时直接使用该路径。默认值在配置入口使用生成装配传入的完整 API 前缀解析一次，下游使用确定的路径；本地匹配键去除非根路径的尾斜线，实际请求沿 HTTP 的 trailingSlash 策略处理，redirectUri 保持登记原值。自定义后只注册所选路径，不保留默认路径别名。

Node 按实例、Workers 按当前外部事件使用真实 Env 解析配置，在资源创建前校验路径及实际方法/路径冲突。静态路由结构可以复用，但不能用伪造环境执行工厂来探测路径，也不能由生成器只按 id 拼接默认路径。框架端点与业务路由及其他提供方共同参加冲突检查，不独占整个 `/auth` 前缀。

## 事务 Cookie

发起入口生成 state，适用提供方生成 PKCE verifier，OIDC 同时生成 nonce；Apple 沿其支持的 nonce/state 与 form_post 流程，不发送 PKCE 参数。授权 URL 由上游构造。事务值保存在服务端签名的短期 Cookie，内容绑定提供方、用途、创建/过期时间与完整注册回调。密钥来自显式 app.cookie.secret，不复用 JWT 密钥；启用却缺密钥在资源创建前拒绝。

状态 Cookie 使用 oauth_state_<id> 命名，默认十分钟、HttpOnly，每个提供方独立；重新发起同一提供方登录替换其未完成事务。Cookie Path 取公开 redirectUri 的 pathname，并去除非根路径的尾斜线，使其同时匹配 HTTP 规范化前后的回调地址；设置与清除使用同一 Path，不使用代理改写后的本地 callbackPath。登记的 redirectUri 保持不变。标准 GET 回调采用 Lax；跨站 form_post 的提供方采用 SameSite=None; Secure。属性不同不影响第一方会话 Cookie。

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

OIDC 的 email 优先取 ID Token，缺省时取已验证 subject 的 UserInfo。emailVerified 只取对应同一邮箱地址的声明；两个来源的邮箱相同时才允许补充缺失的验证状态，不把一个地址的验证结果套给另一个地址。

expiresAt 为 Unix 秒，refreshToken 按提供方响应提供。凭据通过 tokens 传给服务端回调。profile.raw 保留资料响应，微信资料也不携带令牌响应。应用需要调用第三方 API 时自行选择持久化与刷新策略。

## Node、Workers 与 MFA 的衔接

Node 和 Workers 使用相同协议与 Cookie 行为，资源和秘密来自所属环境，外部请求传递取消信号。openid-client 沿用其默认 30 秒 HTTP 操作时限；GitHub/WeChat 原生适配使用相同的单次操作时限，覆盖响应正文读取。该时限不是整个登录事务的期限，不限制用户在提供方页面的停留时间。可选 GitHub 邮箱补充超时只放弃该补充，当前请求取消仍中止整个流程，不自动重试。多实例只需正确共享配置/密钥与应用所用数据，不依赖某个实例内的 OAuth 事务 Map。

应用可在映射账户后调用 ctx.var.mfa.beginSignIn，而不是先签发完整 session 再要求第二步。OAuth 成功不自动证明完成本地 TOTP；是否采信第三方提供的认证方式和验证结果，由应用按其信任策略决定。

本模块是第三方认证的客户端，不提供 OIDC Provider。远期站点身份联邦不改变当前模块职责，也不提前创建供应方服务。

## 验证

用协议夹具验证真实回调、scope/nonce/PKCE、GET/form_post Cookie、错误和令牌交付；分别验证 Node/Workers 打包与请求链路。覆盖默认及自定义发起/回调路径、固定 query、代理改写后的本地路径、Cookie 设置与清除 Path，以及实际方法/路径冲突。厂商真实联调有相应凭据前提，不能把静态示例称为全部厂商联调完成。

提供方协议参考：[Google 发现元数据](https://accounts.google.com/.well-known/openid-configuration)、[Microsoft 发现元数据](https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration)、[Apple 发现元数据](https://appleid.apple.com/.well-known/openid-configuration)、[Apple 适配参考](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/apple.ts)、[Apple 换码要求](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)、[GitHub 授权码与 PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。
