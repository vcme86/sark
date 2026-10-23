# TOTP 认证因素

## 范围与上游

TOTP 提供验证器密钥的绑定、重绑、验证、关闭与重加密。登录、再次认证、挑战、账户尝试次数限制和恢复码归 [mfa.md](mfa.md)，不在 TOTP 内复制。

使用 otplib 13 的 @otplib/totp、@otplib/core、@otplib/uri，配 @otplib/plugin-crypto-web 和 @otplib/plugin-base32-scure。复用随机密钥、Base32、otpauth URI、时间窗口匹配和 afterTimeStep；不从主入口先加载未使用的默认 crypto 后端。[otplib 防重放接入](https://otplib.yeojz.dev/guide/advanced-usage)

## 声明

```ts
import { defineTotp } from '@olivaw/sark/auth/totp'
import { sqlTotp } from '@olivaw/sark/auth/totp/sqlite'

type Env = NodeJS.ProcessEnv

export const totp = defineTotp((env: Env) => {
  const key = env.TOTP_KEY
  if (!key) throw new Error('TOTP_KEY is required')
  return {
    issuer: 'Example',
    keys: { current: { id: 'k2', key: decodeKey(key) } },
    store: sqlTotp({ database }),
  }
})
```

这是 Node/SQLite 示例；Workers 使用 Wrangler Env 并选择 D1 适配，环境约定见 [application.md](application.md)。decodeKey 是应用解析部署密钥的函数，验证编码后返回 32 字节。Node/PG 与 CF/D1 从对应子路径选择同名 sqlTotp，不静态加载全部驱动。自定义模型也可提供专用 store。

```ts
interface TotpOptions {
  issuer: string
  keys: {
    current: { id: string; key: Uint8Array }
    retired?: Array<{ id: string; key: Uint8Array }>
  }
  store: TotpStoreDeclaration
  algorithm?: 'SHA1' | 'SHA256' | 'SHA512'
  digits?: number
  period?: number
  epochTolerance?: number
}
```

issuer、keys、store 必需。默认 SHA1、6 位、period=30 秒、epochTolerance=30 秒。period/epochTolerance 沿 otplib 秒单位；epoch 使用 Unix 秒，匹配 timeStep 是时间步序号，不当作毫秒时间戳。

启用 TOTP 需要 session 和共同 MFA 流程；缺依赖在资源创建前报错。Node 默认短期状态或显式共享状态由 MFA 选择，不在 TotpOptions 再放一份 challenge/accountLimit/recovery 配置。

## 公开操作

ctx.var.totp 提供：

```ts
interface TotpService {
  beginEnrollment(): Promise<{ challenge: string; uri: string }>
  confirmEnrollment(challenge: string, code: string): Promise<{ enabled: true }>
  disable(): Promise<void>
  isEnabled(sub: string): Promise<boolean>
}
```

beginEnrollment 从已认证上下文取得主体，按共同管理策略检查近期认证；创建待确认密钥，返回 URI 和用途绑定挑战。待确认密钥在进入共享状态前也用因素密钥加密并绑定 sub/factorId，不以明文保存在挑战表；因素本身尚未启用。

confirmEnrollment 原子进入该绑定流程的 verifying 状态，验证验证码并按原认证因素的版本条件提交。首次插入要求记录不存在，重绑要求现有版本与预期一致；成功后消费挑战。重绑生成新 factorId，不能让旧因素挑战操作新因素。

disable 要求满足统一管理策略中的近期因素认证条件，条件删除当前因素。恢复码管理使用 ctx.var.mfa.regenerateRecoveryCodes；应用可在确认绑定后的同一请求显式调用，框架使用刚完成的验证结果，不自动为任意绑定重置恢复码。

isEnabled 面向已授权的账户管理，不能作为匿名账户枚举端点。`instance.totp.reencrypt(sub): Promise<boolean>` 供维护，主体枚举由应用决定。

登录采用 mfa.beginLogin/complete；TOTP 证明为 { kind: 'totp', code }，不保留第二套 totp.beginLogin/complete/stepUp。

## 因素存取契约

```ts
interface TotpRecord {
  revision: string
  factorId: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
  secret: Uint8Array
  lastStep: number
  enabledAt: number
}

interface TotpStore {
  read(sub: string, context: AuthCheckContext): Promise<TotpRecord | null>
  commit(
    sub: string,
    expectedRevision: string | null,
    next: TotpRecord | null,
    context: AuthCheckContext,
  ): Promise<boolean>
}
```

revision 每次改写由框架产生新值，factorId 仅因素替换时改变。secret 是框架加密后的不透明密文，不由应用解密。lastStep 是最近一次已使用验证码的时间步序号；enabledAt 是 Unix 毫秒。

expectedRevision=null 只在无记录时插入，以主体唯一约束保证。非空时只有相同版本才能替换/删除；false 是正常版本冲突，存储故障抛错。

完成验证时使用 read 得到快照，把 afterTimeStep 传给上游验证器，再把新 lastStep 和 revision 条件提交。同一步并发只能一个成功。不能验证 OTP 后再无条件更新，也不能因后续验证窗口仍覆盖某个时间步而重复接受该步的验证码。

## 默认 SQL 与映射

auth/totp/sqlite、auth/totp/postgres、auth/totp/d1 导出 sqlTotp({ database, tables?: { factors } })。它借用数据库声明，创建实际适配由装配负责。

三个路径各自的 /schema 导出 factors，默认表 sark_totp_factors。主体是主键/唯一键，字段保存上述记录；密文用 BLOB/BYTEA 无损存储。revision 条件写入直接落实到 SQL，不先查后无条件覆盖。

SQLite/D1 用 SQLite 表定义，PG 用原生 PG 定义。应用可直接从 schema 入口再导出到自己的 Drizzle schema；更改物理表/列名时传自己的兼容表对象，不配置任意 SQL 字符串。不同逻辑模型实现 TotpStore。

默认 schema、适配、迁移接入及契约验证随 TOTP 交付，不要求普通应用先写 read/commit。框架不建用户表、不自动改业务表；默认表的选择与资源归属沿 [database.md](database.md)。

自定义 TotpStoreDeclaration 按 [application.md](application.md) 的 create(context) 延迟构造，返回 { value: TotpStore, dispose? }；回调中的 AuthCheckContext 仍属于实际验证执行，不与创建期上下文混用。

## 密钥与重加密

采用 WebCrypto AES-256-GCM，随机 nonce，密文封装包含版本与 keyId，并绑定 sub/factorId。密文挪到另一因素或主体不能解密。

current 负责新加密；retired 按 id 解密旧记录，id 唯一。密钥缺失或认证解密失败报告 key_unavailable，不伪装成 invalid_code，也不重建因素。密钥不从 JWT secret 派生。

成功验证可将旧密文重加密，与 lastStep 消费在同一次 commit 生效。维护 reencrypt 使用条件版本更新，覆盖长期不登录账户；旧密钥保留到所有依赖记录迁移或删除。

## 错误

共同错误使用 challenge_invalid、too_many_attempts、invalid_code、conflict、factor_missing、key_unavailable 和存储故障分类。日志不输出 URI、密钥、验证码和明文恢复码。

## 成本

两步登录包含 begin 的因素检查、共同状态创建/claim/结束、因素读取与条件写入；不能把 complete 的一次 read/commit 当作总成本。普通业务 JWT 请求不重复验证 OTP。

## 验证

验证真实绑定/重绑/关闭、时间窗口与 afterTimeStep、并发消费、密文绑定及轮换，以及 SQLite/PG/D1 默认和自定义适配。测试使用真实时钟控制与目标数据库条件语义，源码与夹具保持统一编译条件。
