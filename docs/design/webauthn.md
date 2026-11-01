# WebAuthn 与 Passkey

## 用途和职责

WebAuthn 支持公钥凭据注册、登录第二步、敏感操作再次认证，以及可发现凭据的无密码登录。它与 TOTP 是独立可选方式，共同挑战、恢复和会话签发归 [mfa.md](mfa.md)。

采用 @simplewebauthn/server 与 @simplewebauthn/browser。上游负责选项、标准响应解析、签名与标记校验和计数规则；Sark 负责 RP/origin 配置、流程绑定、存取原子性及认证结果，不再维护 CBOR/COSE/ASN.1 或字节编码协议。[SimpleWebAuthn 服务端](https://simplewebauthn.dev/docs/packages/server)

## 声明

```ts
import { defineWebAuthn } from '@olivaw/sark/auth/webauthn'
import { sqlWebAuthn } from '@olivaw/sark/auth/webauthn/d1'

export const webauthn = defineWebAuthn({
  rpId: 'example.com',
  rpName: 'Example',
  origins: ['https://example.com'],
  store: sqlWebAuthn({ database }),
  user: async (sub, context) => loadAccountLabel(sub, context),
})
```

WebAuthn 请求操作统一挂载在 ctx.var.webauthn，沿当前请求的身份、取消及响应 Cookie 生命周期执行，不提供无请求身份的注册或登录服务。

rpId、rpName 及 origins 的必需环境值可以为 undefined，由所属配置入口验证；解析结果仍保证有效 RP 与非空来源列表。

loadAccountLabel 由应用返回 { userName, displayName }。两者来自服务端账户资料，不从浏览器提交名称决定主体。store、rpId、rpName、非空 origins 和 user 映射必需；需要第一方 session 与共同 MFA。

无密码登录可另外配置 identity；它与用于注册展示资料的 user 回调用途不同：

```ts
type WebAuthnIdentity = Pick<SignInInput, 'sub' | 'ver' | 'roles' | 'claims'>

type WebAuthnIdentityResolver = (
  sub: string,
  context: AuthCheckContext,
) => WebAuthnIdentity | Promise<WebAuthnIdentity>
```

选项字段为 `identity?: WebAuthnIdentityResolver`。这些类型从 auth/webauthn 导出；SignInInput 使用 session 的签发类型，AuthCheckContext 使用认证底层契约，资源类型沿实际声明保留。

第二步的 userVerification 默认 required，可显式选择 preferred/discouraged；无密码登录固定要求用户验证，并创建可发现凭据。普通用户在场不等于指纹/PIN 认证。

RP ID 为域名范围，origins 为实际浏览器来源，二者按 WebAuthn 标准验证；API 内部 DNS 不自动成为 RP ID。跨域 CORS 配置不能放宽 WebAuthn 域约束。默认 attestation=none，不启用 Metadata Service 或企业证明网络。

## 服务端操作

```ts
interface WebAuthnService {
  beginEnrollment(): Promise<{
    challenge: string
    options: PublicKeyCredentialCreationOptionsJSON
  }>
  confirmEnrollment(
    challenge: string,
    response: RegistrationResponseJSON,
  ): Promise<{ credentialId: string }>
  beginAuthentication(challenge: string): Promise<PublicKeyCredentialRequestOptionsJSON>
  beginLogin(options?: SessionOptions): Promise<{
    challenge: string
    options: PublicKeyCredentialRequestOptionsJSON
  }>
  listCredentials(): Promise<CredentialSummary[]>
  removeCredential(id: string): Promise<void>
}
```

类型直接沿上游 JSON 类型。CredentialSummary 只返回当前已认证主体的 ID、创建时间、transports 与设备/备份属性，不暴露公钥存储内部记录。

注册先检查共同近期认证策略，取得稳定 user handle，生成并保存本次 options 预期值；确认时校验注册响应、条件插入唯一凭据，再结束绑定挑战。已有凭据作为排除项；并发首次 user handle 创建由唯一约束解决。

第二步先由 mfa.beginLogin/beginStepUp 建共同挑战，再 beginAuthentication(challenge) 取 options，最后把浏览器 response 交给 mfa.complete。

无密码 beginLogin 不要求预先提供账户，使用可发现凭据。通过共同创建器建立 purpose=webauthn-login 的无主体 AuthFlow，沿同一 AuthStateStore 保存会话选项与协议预期。complete 只接受该用途的 WebAuthn 证明，查找服务端凭据，落实账户窗口并验证 userHandle、challenge、origin、RP、用户验证及归属。不能拿客户端的 sub 直接当已认证主体。

list/remove 只操作当前主体，移除要求近期因素认证，SQL 同时约束 ID、主体和 revision。恢复码由共同 MFA 服务提供，新增一个 Passkey 不自动重置它。

## 无密码账户映射与失败语义

协议验证成功、长期凭据条件更新成功、共同挑战条件消费成功后，才调用 identity(sub, context)，再检查取消、期限及返回资料并签发。未配置时只使用 { sub }，ver/roles/claims 沿 session 默认。应用需要当前账户版本、角色或业务声明时由该回调提供，也可检查账户是否允许登录；框架不猜用户表或角色规则。

返回 sub 必须等于已验证主体，不符时报配置错误并拒绝签发。框架只选取 sub/ver/roles/claims；amr、authTime、authentication 由本次验证结果生成，不受运行时多余字段或保留 claims 覆盖。

identity 抛 HttpError 时保留应用错误语义，其他异常沿共同未知错误处理，内部信息不发给客户端。失败或取消不签发，不退回 pending，不恢复已提交的计数器或重放同一挑战。长期 Passkey 凭据仍保留可用；重新登录从新挑战开始。若回调查询应用数据库，瞬时失败会要求用户重新完成一次 WebAuthn 流程，不保留已消费挑战等待重试。

该回调仅用于无密码 WebAuthn。TOTP、恢复码或 WebAuthn 第二步继续使用 mfa.beginLogin 已保存的 SignInInput；step-up 沿已有身份。它不是全局账户查询钩子，不为每次业务 JWT 验证或其他因素登录增加查询。

## 浏览器接入

从 auth/webauthn/browser 导入 startRegistration、startAuthentication、能力检测与取消接入，沿 SimpleWebAuthn 的 optionsJSON 调用形态：

```ts
const { challenge, options } = await client.post('/auth/passkeys/enroll')
const response = await startRegistration({ optionsJSON: options })
await client.post('/auth/passkeys/confirm', { json: { challenge, response } })
```

这些 API 路由由应用声明并调用上述服务，typed client 复用现有 HTTP 契约。不生成第二套不可控登录端点，也不要求页面运行时才能使用 SDK。

浏览器交互在用户操作或明确生命周期中启动，取消是可识别交互结果，应用决定提示/换方式，不自动重试和跳转。浏览器入口不导入 React、session 或服务端验证 SDK。

## 长期存取契约

auth/webauthn 导出 WebAuthnStore，操作包括：

- getOrCreateUserHandle(sub)：原子取得/建立稳定随机 handle，不能对同一账户每次注册更换
- findCredential(id)、listCredentials(sub)：查找原始验证记录
- insertCredential(record)：凭据 ID 唯一，正常冲突与故障分开
- updateCredential(id, sub, expectedRevision, next)：仅相同版本/归属更新
- removeCredential(id, sub, expectedRevision)：相同版本/归属删除

记录包括 sub、userHandle、credentialId、publicKey: Uint8Array、counter、transports、deviceType、backedUp、revision、createdAt（Unix 毫秒）。revision 由框架生成；userHandle 是不包含邮箱等个人资料的不透明随机标识，不与用户数据库主键混为同一格式。

验签使用上游返回的新 counter，再条件更新；正常零计数由上游规则处理，不一律视为重放。备份属性按真实验证结果维护，不能仅凭名称推断硬件保证。

版本冲突返回 false，真实数据库错误抛错。框架先完成长期凭据提交，再按共同挑战结束/取消规则签发，不在响应失败后自动重放。

## 默认 SQL 适配与迁移

auth/webauthn/sqlite、auth/webauthn/postgres、auth/webauthn/d1 导出 sqlWebAuthn({ database, tables?: { subjects, credentials } })。同一入口仅包含 WebAuthn 适配及两张表：

- webauthnSubjects：sark_webauthn_subjects，主体唯一、稳定 handle 唯一
- webauthnCredentials：sark_webauthn_credentials，凭据 ID 唯一，索引支持主体列表，保存公钥字节及验证元数据

BLOB/BYTEA 与 Uint8Array 无损往返，使用上游前先转换 ORM 返回的原生字节视图；不把 JSON 数字数组或 Buffer 的序列化对象误当公钥。

SQLite/D1 共用 SQLite 表定义，PG 使用独立定义。应用传兼容 Drizzle 表对象可改变物理名，须保留 subjects.sub、subjects.userHandle、credentials.credentialId 各自的唯一约束，并保留凭据主体查询索引；不兼容模型实现 WebAuthnStore。默认表不要求框架用户表或特定用户主键，账户关联政策仍由应用维护。

默认 schema、适配、迁移接入和契约测试随 WebAuthn 一起交付，不把它们推给普通应用。迁移和资源规则沿 [database.md](database.md)。

自定义 store 按 [application.md](application.md) 的 create(context) 延迟构造并返回 { value: WebAuthnStore, dispose? }，借用实际 db/Env，不在声明期打开连接。操作方法只负责上述存取，框架负责注册、认证协议和会话流程。

## 平台与成本

Node 和 Workers 使用平台 WebCrypto 的同一套异步流程。CF 必须完成实际 workerd 打包、注册与认证验证，不以 SDK 能 import 或 Node 上游测试通过作为目标兼容的完成依据。

即便 attestation=none，上游服务端包仍可能包含证明格式解析依赖；选项关闭不等于包体消失。只有启用 WebAuthn 的应用承担它，普通 JWT、TOTP 和纯 API 不导入该 SDK。

## 验证

验证完整注册、第二步、无密码、取消、多凭据管理、user handle 稳定性、counter 条件更新及跨实例共同状态。开发期契约测试复用官方/自定义存取接口，不在生产运行自动探测。

无密码验证覆盖默认 { sub }、应用版本/角色映射、主体不匹配、保留认证字段不可覆盖，以及映射失败/超时取消后不签发、不重放且凭据仍可用于新挑战。
