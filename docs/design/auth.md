# 第一方认证与会话

## 职责与声明

第一方会话验证请求凭据，并提供本应用的身份信息。框架负责 JWT、Cookie/Bearer 选择、失效钩子、续期与认证结果；账户、密码、权限、登录 UI 和业务跳转由应用决定。

```ts
import { defineAuth } from '@olivaw/sark/auth/session'

type Env = NodeJS.ProcessEnv

export const auth = defineAuth((env: Env) => {
  const secret = env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is required')
  return {
    secret,
    expiresIn: 7 * 24 * 60 * 60 * 1000,
    tokenVersion: async (sub, { db }) => readVersion(db, sub),
    validate: async (identity, { db }) => isActive(db, identity.sub),
  }
})
```

这是 Node 工厂示例；Workers 使用 Wrangler Env，必填密钥同样需要检查，环境约定见 [application.md](application.md)。readVersion/isActive 是应用函数。数据库不是会话的必需依赖；只有回调实际使用时声明它。OAuth、TOTP、WebAuthn 和共同 MFA 分别声明，session 不静态导入这些能力。

## 身份与认证结果

```ts
interface Identity {
  sub: string
  ver: number
  jti: string
  amr?: string[]
  authTime?: number
  roles?: string[]
  authentication?: AuthenticationFacts
  claims: Record<string, unknown>
}

interface SignInInput {
  sub: string
  ver?: number
  amr?: string[]
  authTime?: number
  roles?: string[]
  authentication?: AuthenticationFacts
  claims?: Record<string, unknown>
}

type AuthenticationFacts =
  | { method: 'totp' | 'recovery' }
  | { method: 'webauthn'; userVerified: boolean }

interface IssuedSession {
  identity: Identity
  token: string
}

interface SessionOptions {
  cookie?: boolean
}
```

sub 为稳定主体；ver 默认 0；jti 由框架生成。authTime 是 Unix 秒的主动认证时间，缺省不表示刚认证；amr 表达实际认证方式，不能从会话有效或续期推导 MFA 已完成。authentication 通过 JWT 私有声明 sark_auth 保存具体认证方式及验证结果，未执行因素时省略。业务 claims 不覆盖框架保留的身份、签发、期限和因素字段。

SessionOptions、IssuedSession 与会话签发契约统一定义在 session/types，MFA 只用 type import 引用它们。共同身份与资源检查上下文放认证底层契约；session 不引用 MFA 或具体因素服务类型。

## 配置与默认值

```ts
type SigningCredentials = { secret: string; keys?: never } | { keys: SigningKey[]; secret?: never }

type AuthOptions = SigningCredentials & {
  cookieName?: string
  cookie?: {
    path?: string
    domain?: string
    sameSite?: 'lax' | 'strict' | 'none'
    secure?: boolean
  }
  issuer?: string
  audience?: string
  expiresIn?: number
  rolling?: boolean
  tokenVersion?: (sub: string, context: AuthCheckContext) => Promise<number>
  validate?: (identity: Identity, context: AuthCheckContext) => Promise<boolean>
  cacheKey?: (identity: Identity, context: AuthCheckContext) => string
  cacheTtl?: number
}

interface SigningKey {
  kid: string
  secret: string
  retired?: boolean
}
```

secret 与 keys 二选一。应用装配需要唯一活动签发键，kid 不重复；简单模式无 kid，轮换模式签发写 kid、验签精确选键，不遍历猜测。缺少对应键拒绝。纯验签函数允许仅提供验证所需的已退役键。

固定 HS256，复用 Hono JWT/WebCrypto，不提供多算法选择器。密钥满足 HS256 的长度要求，至少 32 个 UTF-8 字节；推荐随机秘密，不能用可预测口令充当安全密钥。[RFC 7518 §3.2](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.2)

cookieName 默认 auth_token；cookie 只配置本会话的专用属性，HttpOnly 固定开启。expiresIn 默认 604800000 毫秒，仅接受有限正数；rolling 默认 true。issuer/audience 可选，配置后签发写入并按同值校验，未配置时不校验相应声明，不从 Host 猜预期值。cacheTtl 默认 0 秒，即关闭钩子缓存。

签名配置不读取 cookie.secret 或隐式环境变量。使用工厂时由 Node/Workers 宿主提供 Env。

## 凭据选择与验证

浏览器 Cookie 与 Authorization Bearer 都解析成同一 Identity。出现 Bearer 时优先选择它；它无效也不回落 Cookie。只有 Cookie 时按 Cookie 验证。

每次请求依次验证签名、时间约束、已配置 iss/aud、当前版本和 validate。身份解析失败得到匿名，业务决定是否要求登录；真实存储故障记录原因，不假装跳过检查。

AuthCheckContext 提供 logger、signal、可选 request 及已声明的资源实例，保留各资源的具体类型。没有数据库时不虚构 db；回调不依赖包含自身的 AppInstance。缺 request 的服务级验证仍调用 validate，依赖 request 的应用检查应明确拒绝，不静默绕过。

## 请求与实例服务

```ts
interface RequestAuth {
  readonly identity: Identity | null
  signIn(input: SignInInput, options?: SessionOptions): Promise<IssuedSession>
  signOut(): Promise<void>
}

interface AuthService {
  verify(
    token: string,
    options?: { request?: Request; signal?: AbortSignal },
  ): Promise<Identity | null>
  authenticate(request: Request): Promise<Identity | null>
}
```

ctx.var.auth 绑定当前请求。signIn 默认 cookie=true，写入本外层响应；cookie=false 只返回 IssuedSession，由应用交付 Bearer token。token 不进入启动载荷，不自动放进 Cookie 登录响应正文。

instance.auth 只验证，不写 Cookie、不隐式签发。脱离请求签发使用 signToken(input, options)，验签使用 verifyToken(token, options)。纯函数显式接收 secret/keys、issuer、audience 和签发期限，只验证密码学与声明，不执行账户钩子。

```ts
function signToken(
  input: SignInInput,
  options: SigningCredentials & { issuer?: string; audience?: string; expiresIn?: number },
): Promise<string>

function verifyToken(
  token: string,
  options: SigningCredentials & { issuer?: string; audience?: string },
): Promise<Identity | null>
```

纯函数签发期限缺省同为七天。

## Cookie 与自动续期

会话 Cookie 直接存放 JWT，默认 HttpOnly、SameSite=Lax、生产 Secure，不再套通用签名；只需认证密钥。Path 默认 /，其他专用属性按公开应用部署配置，不把内部 API DNS 写入 Domain。

有效 Cookie 剩余期限不足 expiresIn 一半时，在提交响应头前准备换发。新过期时间为当前时刻加 expiresIn；保留 sub、ver、jti、amr、authTime、authentication、业务 claims 与首次 iat。这是延长会话有效期，不是再次认证，也不提供绝对最长会话时长。

每个外层请求只决定一次续期，SSR 内部 API 不重复签发。显式 signIn/signOut 优先，自动换发不得覆盖退出。过期/失效令牌不续期；Bearer 不自动滚动，由应用明确换发。

Cookie 有效期不超过 JWT 期限，所有 Set-Cookie 在响应头提交前写入，不能在 SSR 结束后补写。

## 失效与钩子缓存

tokenVersion(sub) 返回应用当前版本，逐请求与 ver 比较；未配置则没有版本检查。validate 用于账户状态、租户、权限或 jti 撤销，未配置不调用。

只缓存钩子结果，不缓存「整个凭据已认证」：

- 签名、时间及已配置 issuer/audience 仍逐请求校验
- tokenVersion 缓存按完整凭据指纹，缓存命中仍比较版本
- validate 只有显式配置 cacheKey 才缓存结果并合并相同键的并发检查；没有 cacheKey 时每次调用 validate
- cacheKey 接收与 validate 相同上下文，等价维度由应用决定
- TTL 大于零意味着状态更新最多滞后相应秒数；实时副作用与实时撤销不应放进这份缓存

signOut 清 Cookie，本身不能撤销已复制的 JWT。单次撤销由应用按 jti 的状态检查实现；全部设备退出可递增版本。是否需要即时撤销及其存储由应用决定，框架不默认建立 session/撤销表。

## 再次认证守卫

auth/session 导出 requireStepUp({ maxAge, amr? })，maxAge 为毫秒。它检查已有身份、authTime 是否足够近，以及指定的全部 amr；不满足返回 403，错误码为 step_up_required，不自动导航或执行业务授权检查。

MFA 成功后记录本次认证方式及验证结果，普通续期不刷新这些记录。SignInInput 中的认证结果来自应用已验证的流程，不接受浏览器自报认证方式。

## 平台与准入顺序

Node 多副本和 Workers 使用一致的密钥及所需账户状态来源；JWT 会话不会因此强制建表。业务身份解析先于适用 CSRF，只有已通过 Bearer 认证的请求才有对应豁免。

## 验证

验证覆盖选键、已配置 issuer/audience、失效时效、Cookie/Bearer 优先、响应头提交前续期与显式退出优先；未启用因素/OAuth 时不加载其 SDK。session 不增加 purpose 字段，MFA 流程的用途另由该领域维护。认证后的页面快照与跳转沿 [pages.md](pages.md)，不根据业务响应自动更新页面身份或执行跳转。
