# 多因素认证、挑战与恢复

## 共同职责

MFA 连接应用已验证的第一步身份、已选 TOTP/WebAuthn 认证因素、统一挑战流程与第一方会话。它不验证业务密码，不决定用户权限或页面跳转。

session、oauth、totp、webauthn 在认证领域内并列。MFA 只使用 session 的签发契约和注入的因素验证器，不静态导入全部 SDK。没有因素时不创建空 MFA 服务；只声明 mfa 却没有因素时报组合错误。

实现中，MFA 策略与共同认证执行分开：auth/state 管理挑战，auth/verification 负责条件消费、取消和最终签发，auth/mfa 管理第二步策略与请求门面。无密码 WebAuthn 沿既有 mfa.complete 入口调用共同执行器，不因此被认定为多因素认证。TOTP 维护接口由 TOTP 自身装配，通用因素契约不引用具体因素的维护类型。

## 声明与默认值

```ts
import { defineMfa } from '@olivaw/sark/auth/mfa'
import { sqlRecovery } from '@olivaw/sark/auth/recovery/d1'
import { sqlAuthState } from '@olivaw/sark/auth/state/d1'

export const mfa = defineMfa({
  state: sqlAuthState({ database }),
  recovery: { store: sqlRecovery({ database }), count: 10 },
  signIn: 'if-enrolled',
})
```

database 是应用已有声明。Node 单进程启用因素后可省略 mfa，使用默认内存短期状态和共同策略；不因此启用恢复码。CF/多实例需要显式选择满足共享语义的状态后端。官方提供 PG/D1，允许等价自定义实现，不把特定数据库作为唯一合法选择。

```ts
interface MfaConfig {
  state?: AuthStateStoreDeclaration
  signIn?:
    | 'required'
    | 'if-enrolled'
    | 'skip'
    | ((identity: SignInInput, context: AuthCheckContext) => SignInPolicy | Promise<SignInPolicy>)
  challenge?: { ttl?: number; maxAttempts?: number }
  accountLimit?: { window?: number; maxAttempts?: number }
  recentAuthMaxAge?: number
  recovery?: { store: RecoveryStoreDeclaration; count?: number }
}
```

SignInPolicy 为上述三个字符串。默认 signIn=if-enrolled；challenge.ttl=300000 毫秒，maxAttempts=5；accountLimit.window=600000 毫秒，maxAttempts=10；recentAuthMaxAge=300000 毫秒。所有期限有限正数，次数正整数。

内存状态默认最多 1000 个挑战和 10000 个账户/用途窗口。需要调整时从 auth/mfa 取得 memoryState({ maxChallenges?, maxAttemptWindows? }) 并作为 state；该实现仅支持 Node 单实例。容量满时拒绝新流程，不通过驱逐有效账户窗口重置限制。

恢复码 count 默认 10。只有显式配置 recovery 才启用，默认 schema 和适配随能力交付，不强迫应用手写持久化。

## 请求服务与完整登录链路

```ts
type FactorProof =
  | { kind: 'totp'; code: string }
  | { kind: 'recovery'; code: string }
  | { kind: 'webauthn'; response: AuthenticationResponseJSON }

type SignInResult =
  | { status: 'authenticated'; session: IssuedSession }
  | { status: 'challenge'; challenge: string; methods: Array<'totp' | 'webauthn' | 'recovery'> }

interface RequestMfa {
  beginSignIn(input: SignInInput, options?: SessionOptions): Promise<SignInResult>
  beginStepUp(options?: SessionOptions): Promise<{ challenge: string; methods: FactorKind[] }>
  complete(challenge: string, proof: FactorProof): Promise<IssuedSession>
  regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] }>
}
```

FactorKind 为所启用的因素种类及 recovery。上例展示同时启用两种因素时的完整服务形态；实际 `RequestMfa<Proof>` 由所选因素的类型合成，MFA 底层契约只接收泛型证明，不直接导入 WebAuthn SDK。未配置 WebAuthn 不要求安装其类型/SDK。

应用验证密码或外部账户后调用 beginSignIn。required 没有可用方式时报明确错误；if-enrolled 在已绑定时要求完成一个可用因素，否则直接签发；skip 按应用已验证的第一步签发，框架不凭空补写因素验证结果。SignInInput 是可信服务端签发资料，authTime、amr、auth 均由应用根据实际验证结果构造；skip/无已绑定因素时保留这些事实，完成共同挑战后以本次因素结果更新。不得将请求正文或未经再次验证的旧会话字段直接展开为 SignInInput。需要 MFA 时不提前交付完整 session。

页面选择 TOTP 直接提交 code；选择 WebAuthn 先取得 options、调用浏览器 SDK，再把 response 交给 complete。恢复码只在已配置且账户有可用恢复材料时出现，不把恢复码存在说成绑定了 TOTP。

beginStepUp 从当前已认证上下文取得主体，不能接受浏览器另传 sub。共同挑战绑定用途和第一步认证结果；绑定挑战不能用于登录，登录挑战不能用于更改他人因素。

无密码 WebAuthn 从其 beginSignIn 开始，通过注入的共同流程创建器建立 purpose=webauthn-sign-in、尚无 sub 的 AuthFlow，绑定 SessionOptions 与协议预期，保存到同一 AuthStateStore，不另建挑战表。该流程只接受 WebAuthn 证明；未知账户时不列出 TOTP/恢复码。

已验证凭据确定账户后，经共同 complete 完成账户窗口、因素版本及挑战消费，再按 [webauthn.md](webauthn.md) 的可选 identity 映射签发。不伪造先前密码步骤，也不在一次成功用户验证后默认再要求相同第二步。

## 认证结果与管理授权

成功后记录具体认证方式以及 WebAuthn 是否完成用户验证。JWT 的 amr 按实际认证方式填写：TOTP/恢复码记 otp；WebAuthn 记 pop，表达已完成的密钥持有证明，不从 Passkey 名称断言硬件、指纹或 PIN。

具体方式通过 JWT 私有声明 auth 保存在 session 中，映射为 Identity.auth；authTime 是本次主动认证时间。恢复码不冒充 TOTP，普通续期不刷新这些认证结果。

首次绑定需要近期第一方认证；账户仍有 TOTP、WebAuthn 凭据或可用恢复码时，新增、重绑、移除、关闭及恢复码重置需要近期已完成因素认证。框架统一执行这些要求，不把保护敏感操作留给应用记忆。应用可以提出更严格的业务授权，但框架不代它判断角色。

regenerateRecoveryCodes 基于当前会话中近期完成的因素验证结果，或同一请求刚由框架确认完成的因素绑定结果；不接受客户端自报的 amr。它显式生成新组、原子替换旧组，明文仅返回一次。恢复码替换及因素删除在异步读取后、写入前检查请求取消；已提交结果不因随后取消而回滚。普通新增凭据不自动重置恢复码，避免无关管理操作使用户旧码失效。

## 状态机与一次性完成

短期状态保留：不透明随机 ID、用途、主体（可发现凭据登录开始时可无主体）、第一步/签发选项、所选方式、协议预期值、因素绑定、期限、attempts、状态、revision 与当前验证操作标识 claimId。

流程为 pending → verifying → consumed：

1. 读取并检查用途/期限，原子进入 verifying 状态，记录本次 claimId，并增加挑战及已知账户窗口的尝试次数
2. 读取所属长期因素，调用上游验证证明
3. 写入前检查取消和挑战期限，按读取版本条件更新因素，或单次消费恢复码
4. 原子结束挑战，再检查执行取消和期限
5. 无密码 WebAuthn 调用其 identity 映射取得应用签发资料；其他登录沿已保存的 SignInInput，step-up 沿已有身份
6. 再检查取消、期限及签发资料，记录实际认证方式及验证结果，通过 session 签发会话

空码、位数或字符格式错误与不匹配的证明均返回 invalid_code，不将上游格式异常当作服务故障。错误证明且未超限时，仅当 claimId 匹配当前验证操作时才可退回 pending，已使用次数保留。过期、超限、版本改变、存储结果不确定或取消时终止；迟到结果不签发。不自动重置 verifying 状态或允许另一请求接管，避免先前验证尚未结束时并发提交。

无密码流程先按响应中的 credential ID 查找服务端记录，得到待验证主体后，在同一次 claim 中检查账户尝试限额并进入 verifying；查到记录不代表已认证。随后验证协议证明，提交前仍检查因素版本/归属。未知凭据不建立虚假身份，外部失败不泄露凭据资料。

WebAuthn 的协议 challenge 与共同流程句柄分开。第一次取 options 时原子绑定预期值和 RP/origin/验证要求；同一有效流程重复取得同一份 options，不因页面重试取选项而更换 challenge。

因素消费与短期状态可能在不同存储，因此不承诺一次事务覆盖整个流程。已消费证明而响应丢失不自动重放；中断后无法确认完成状态的验证操作不能继续，应用重新发起。框架负责这些顺序和失败语义，自定义适配不复制整个 complete。

identity 映射或签发失败同样不退回 pending，不撤销已提交的因素状态；只在成功签发后交付 token/Cookie。应用数据库瞬时失败可能要求用户重新完成一次无密码流程，长期凭据仍可使用。这是无跨存储补偿、不重放已消费证明的明确取舍。

## 自定义短期存储契约

auth/mfa 导出 AuthStateStore 与其数据类型。核心操作为：

AuthFlow 包含 id、revision、purpose、可选 sub、createdAt/expiresAt、attempts/maxAttempts、status、可选 claimId、data，以及可选 protocol。purpose 为 sign-in/step-up/enroll-totp/enroll-webauthn/webauthn-sign-in；status 为 pending/verifying/consumed。时间戳使用 Unix 毫秒。data 保存第一步/签发选项、因素绑定及待绑定材料；protocol 保存一次性绑定的协议预期。两者都是框架构造、适配原样保存的 JSON 对象，适配不解释协议私有字段或业务 claims。字节按框架格式编码，待绑定 TOTP 只保存密文。

- create(flow)：仅当 ID 不存在时建立 pending；存储失败和正常冲突分开
- read(id)：返回所属流程或 null
- bindProtocol(id, expectedRevision, protocol, now)：仅在 protocol 尚未设置且 revision 匹配时条件绑定，返回 AuthFlow；并发时返回已经绑定的有效版本，不覆盖已绑定的协议参数，失效返回 null。存储只判断通用 protocol 是否存在，不读取 webauthnOptions 等提供方私有键
- claim(id, claimId, now, account?)：原子检查 pending、用途期限、次数与账户窗口，写入 verifying 状态及 claimId，并增加尝试次数；返回 { status: 'claimed', flow }，或 { status: 'invalid' | 'limited' }。account 包含服务端确定的 sub、用途、window 与 maxAttempts，窗口计数与本次 claim 共同成立
- release(id, claimId, now)：仅 claimId 匹配且仍可重试时退回 pending，不重置次数
- consume(id, claimId, now)：仅 claimId 匹配、用途与期限仍有效时结束；条件不符返回 false

create/read/bindProtocol/claim/release/consume 均异步；create 成功返回 true、ID 唯一冲突返回 false，release/consume 返回 boolean。输入及返回的 flow、data、protocol 均按值隔离：返回值是快照，调用方修改不能改变已持久化的协议预期或流程状态；内存实现与 SQL 实现保持相同语义。真正存储故障始终抛错，不混为 invalid/limited。窗口按主体与用途隔离，不能因换挑战 ID 重置。

now 与过期时间为 Unix 毫秒，claimId 由框架随机生成；flow/protocol 类型为框架导出的有界数据结构，不允许自定义 store 用任意业务正文充当流程。store 负责这些操作的原子性与跨执行可见性，框架负责状态机、密码学和授权语义。

自定义短期/恢复 store 以延迟 create(context) 返回 { value, dispose? }，沿 [application.md](application.md) 的资源约定取得实际 db/Env。替换适配不要求应用在配置导入时创建连接，也不授予它关闭借用资源的权力。

普通 get/set 或最终一致读取不足以实现该契约。官方 PG 使用事务/条件更新，D1 使用条件 SQL 与真实 batch；后续状态写入均通过条件匹配当前 claimId，不能把零行条件更新当作回滚。共享后端按索引和有界批次清理过期状态，不要求应用开启 jobs。

操作读取时仍按 now 检查期限，正确性不依赖清理是否已运行。官方 SQL store 在流程/账户窗口写入路径按时间或次数节流触发有索引支持的批量过期删除，同实例合并清理；Workers 非关键清理通过 waitUntil 跟踪，不新增定时任务。空闲时不唤醒回收，恢复写入后继续；清理不续期挑战、不重置有效账户窗口、不接管 verifying。批量与节流常量属于内部实现，需验证持续写入时回收不会长期积压，不增加应用配置字段。

## 默认恢复码与 SQL schema

恢复码是高熵随机值，框架保存验证所需的 SHA-256 摘要。每个主体一份带 revision 且数量受 count 限制的摘要集合，无须另建分组表和明细表。消费以 revision 条件更新移除摘要；同一版本只允许一个提交。生成、比对、revision 构造属于共同恢复服务。

摘要解码后按相同固定长度字节比较：Node 使用 node:crypto 的 timingSafeEqual，Workers 优先使用平台扩展 crypto.subtle.timingSafeEqual，不引入另一套密码学依赖。共同运行包保留 Node 原生比较函数导入及 Buffer 字节转换，Workers 沿框架既定 nodejs_compat 基线运行。常量时间比较不替代 revision 条件消费。[Workers timingSafeEqual](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal)

```ts
interface RecoveryCodeSet {
  revision: string
  hashes: string[]
}

interface RecoveryStore {
  read(sub: string): Promise<RecoveryCodeSet | null>
  commit(
    sub: string,
    expectedRevision: string | null,
    next: RecoveryCodeSet | null,
  ): Promise<boolean>
}
```

null 期望值只允许首次唯一插入；非空值执行条件替换/删除，false 表示冲突，故障抛错。只保存摘要和主体关联，不建立用户表。

默认恢复适配从 auth/recovery/sqlite、auth/recovery/postgres、auth/recovery/d1 导入 sqlRecovery。同一入口导出 recoveryCodeSets 表定义，物理名 recovery_code_sets。参数为 { database, tables?: { codeSets } }。

短期 PG/D1 的 schema 分别从 auth/state/postgres、auth/state/d1 导入，导出 authChallenges、authAttemptWindows，物理名 auth_challenges、auth_attempt_windows；sqlAuthState 接受 { database, tables?: { challenges, attemptWindows } }。

默认表名固定，传入兼容 Drizzle 表对象可改物理名；不传字符串拼表名。SQLite/D1 与 PG 分别提供对应列类型及必要唯一/期限索引。表定义可由应用 schema 入口再导出给 drizzle-kit，迁移执行归正常部署，不在启动时 DDL。

自定义表还须保留条件写入所依赖的唯一约束：恢复表 sub、挑战表 id、账户窗口表 windowKey 必须分别唯一。windowKey 编码账户主体与用途，不是账户 ID。列形状校验不代替数据库约束；复合唯一键不能代替这些单列唯一键。不兼容的逻辑模型实现专用 Store，不向默认适配传入缺少约束的表。

## 验证

MFA、TOTP、WebAuthn、恢复码的默认适配和专用契约同期交付。验证覆盖实际内存/PG/D1 状态竞争、过期、尝试、错误证明重试、取消、因素版本变化、恢复码消费和最终签发。

无密码链路另验无主体创建、证明类型约束、账户确定、identity 映射失败/取消零签发，以及已消费挑战不可重放；SQL 清理另验读取先拒绝过期、写入节流回收和有效窗口不被清除。

自定义适配可复用同一套开发期契约测试；框架对官方适配负责真实后端验证，不在生产导入测试工具。

## 成本

共享流程会增加创建、读取、尝试和消费的数据库操作，长期因素也有条件读写；普通 session 验证不执行这些 MFA 操作。不启用某因素就不导入其 SDK，不启用恢复码就不创建对应表或服务。完整流程的成本不能只计算一次验证码校验。
