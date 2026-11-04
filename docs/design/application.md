# 应用声明、装配与运行

所有声明及宿主配置遵循 [configuration.md](configuration.md) 的共同规则；本篇规定应用入口、具体配置字段、策略继承和生命周期。

## 一个入口，分别声明

应用根目录默认使用 app.ts。核心配置和所选能力统一具名导出，框架负责发现和组合。

```ts
import { defineApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/sqlite'

import * as schema from './db/schema'

export const app = defineApp({
  bodyLimit: 2 * 1024 * 1024,
  cors: { origin: 'https://example.com', credentials: true },
})

export const database = defineDatabase({
  filename: './data/app.sqlite',
  schema,
})
```

省略 app 使用核心默认值；入口文件不存在时也可创建最小应用。可选能力按声明及专项规定的启用条件装配，未启用能力不加载；例如 Node 单进程启用认证因素后，可使用 [mfa.md](mfa.md) 规定的默认短期状态，不因此启用恢复码。配置较多时，可以通过普通模块导入和显式再导出拆分，文件扫描只从这个入口跟随明确引用。

固定配置导出名为 app、runtime、page、database、storage、assets、auth、oauth、totp、webauthn、mfa、visitors、stats、jobs、rateLimit、logging、health、metrics、pageCache。每个名字由所属能力验证，不变成 AppConfig 的字段。storage 是具名存储集合，oauth 和 jobs 各表示一个列表。页面由发现结果启用；page 仅在需要页面传输或身份配置时声明。

入口不接受默认导出、export star、CommonJS 动态导出或未知运行配置名。纯类型导出不启用能力。发现规则见 [build.md](build.md)。

## 声明与环境

声明函数只保存配置意图、类型及所属初始化引用；模块导入和 define 调用不连接数据库、不监听端口、不创建任务或文件输出。

各声明接受选项对象或 `(env: Env) => Config` 工厂。工厂在相应宿主环境可用后解析，仍只返回配置；实际资源由框架创建。导出集合保持静态，不随某个环境值动态增删能力。不以工厂返回 false 隐式改变服务类型，能力内部的既定开关仍按其专项处理。

驱动种类由导入子路径确定，工厂只提供该驱动的地址、密钥或 binding，不在工厂内切换数据库种类。构建只读导出语法，不执行工厂、不连接生产资源。Node 标准入口负责先加载环境，Workers 从本次事件 env 取得绑定。

### 应用环境与必填值

普通应用统一使用一个 Env 类型。Node 标准入口传入 `NodeJS.ProcessEnv`，应用可直接使用这个类型或定义同名别名。环境变量仍可能缺失，工厂可直接交付原始值，由所属配置入口校验：

```ts
import { defineDatabase } from '@olivaw/sark/db/postgres'

type Env = NodeJS.ProcessEnv

export const database = defineDatabase((env: Env) => ({ url: env.DATABASE_URL }))
```

Workers 使用 Wrangler 生成的 Env，其中 D1、R2 等 binding 保留实际平台类型；生成入口传当前事件的 env，不用 ProcessEnv 代替 binding。环境类型由应用或平台提供，不由框架创建隐式全局 Env。

Node 标准入口不会把字符串自动解析成自定义对象，也不会把缺失变量变成必填字符串。工厂若要求 `{ DATABASE_URL: string }` 等比 ProcessEnv 更窄的类型，标准入口的调用应在类型检查时报错；需要这种输入时，由测试或自定义宿主显式检查、构造满足要求的对象，再传给 createApp。不通过断言把原始 process.env 伪装成已校验对象。

## 核心配置

```ts
interface AppConfig {
  headers?: Record<string, string | false> | false
  bodyLimit?: number | false
  trustedProxies?: Array<'loopback' | 'private' | string>
  cookie?: {
    secret?: string
    sameSite?: 'lax' | 'strict' | 'none'
    secure?: boolean
  }
  cors?: false | CorsOptions
  csrf?: boolean | { origins?: string[] }
  trailingSlash?: 'never' | 'always' | 'ignore'
  caseSensitive?: boolean
  hosts?: string | string[]
  middleware?: MiddlewareHandler[]
}
```

- headers 提供默认响应头。单项字符串覆盖默认值，false 在配置解析时移除该默认项，整体 false 关闭默认头；头名按大小写不敏感匹配。应用显式设置的同名响应头优先，不被禁用默认项的配置删除
- bodyLimit 默认 1048576 字节，false 关闭；以最终有效策略检查声明长度，未知长度随消费计数，详见 [http.md](http.md)
- trustedProxies 默认 loopback 和 private；显式空数组关闭 Node 转发头采信
- cookie 默认 SameSite=Lax，生产 Secure；通用签名密钥须显式赋值，不从认证密钥或全局环境暗取
- cors 默认关闭，启用必须给 origin，选项沿 Hono CORS
- csrf 默认开启，执行适用 HTTP 来源检查与 WS 握手来源检查
- trailingSlash 默认 never；caseSensitive 默认 false；hosts 默认不限制
- middleware 默认空数组，按声明顺序接入 Hono；Context 与 MiddlewareHandler 从包根导入，保留本应用实际声明的资源和请求服务类型

数据库、认证、统计、日志增强、缓存和任务的配置由各声明拥有。压缩、排空预算和基础探针归 Node runtime。

默认基础安全头为：

- `X-Content-Type-Options: nosniff`，要求交付正确的 Content-Type
- `X-Frame-Options: SAMEORIGIN`，默认仅允许同源框架嵌入；跨站嵌入时由应用删除该头并明确配置 CSP frame-ancestors
- `Referrer-Policy: strict-origin-when-cross-origin`，明确跨源来源信息策略

HSTS、CSP、COOP、CORP 不自动启用，由应用按部署与资源交付需要配置。

时间字段按含义命名。运行控制时长通常为毫秒，协议秒数、缓存秒数和 OTP 字段按各自契约的单位；时间戳另外标明 Unix 秒或毫秒。类型、示例与实际使用保持一致，不普遍添加单位后缀。

## 策略继承

应用 → 目录作用域 → 路由，逐字段覆盖。作用域通过 _middleware.ts/.js 的具名 scope 声明 bodyLimit、cors、csrf，以及启用限流后的 rateLimit；默认导出仍为 Hono 中间件。

API 树与页面树分别按匹配文件的祖先链组合中间件，不合成一个按 URL 前缀注册的作用域表。group 不增加 URL 段，平铺点号与目录形式使用同一逻辑层级。页面中间件只处理服务端页面请求；同应用 SSR 的内部 API 调用执行目标 API 链与适用应用中间件，不重复页面链。浏览器导航调用 API 时只执行该 API 的链。

```ts
export const scope = { bodyLimit: 4 * 1024 * 1024 }

export default async function middleware(ctx, next) {
  await next()
}
```

路由可覆盖 middleware、bodyLimit、cors、csrf 和所属能力的局部策略。资源、服务、宿主及页面存储配置只允许应用入口声明。构建与创建阶段分别检查静态和动态值，错误指出来源。

匹配目标后计算一次有效策略，再执行声明式限制。放宽局部正文上限不能先被全局上限拒绝。显式安装的中间件仍按 Hono 顺序独立执行，不因函数引用相同而去重。

策略合并以已解析应用配置为起点，只应用目录和路由的显式覆盖；不在策略计算或执行阶段重新补框架默认值。

## 创建与实例

```ts
import { createApp } from '@olivaw/sark'

import { definition } from './.build/app'

const instance = await createApp(definition, { env: process.env })

try {
  const response = await instance.fetch(new Request('http://localhost/api/ping'))
  await response.arrayBuffer()
} finally {
  await instance.close()
}
```

这是测试或主动嵌入现有宿主时的用法，普通应用由生成入口完成创建。createApp 使用同版本生成的 definition，不提供手写装配 DSL。框架自身测试从源码调用同一个内部 createDefinition，避免复制创建流程。

公开类型关系为 `createApp<D extends AppDefinition>(definition: D, ...options: EnvironmentArgs<D>): Promise<AppInstance<D>>`。EnvironmentArgs 在定义需要 Env 时要求 env，否则允许省略；资源与服务保留定义的具体类型。定义含静态路由、模块和装配引用，不保存某次请求、身份或首次 env。

### 环境要求的类型合成

工厂声明在类型中保留输入 E，对象声明不要求环境。生成定义合成所选声明的要求，多个工厂取交集；应用通常使用同一个 Env，无须手工编写交集类型。内部类型关系为：

```ts
declare const environment: unique symbol

interface RequiresEnv<E> {
  readonly [environment]: (env: E) => void
}

type EnvOf<D> = D extends RequiresEnv<infer E> ? E : unknown

type MergeEnvironments<Declarations extends readonly unknown[]> = Declarations extends readonly [
  infer First,
  ...infer Rest,
]
  ? EnvOf<First> & MergeEnvironments<Rest>
  : unknown

type EnvironmentArgs<D> =
  D extends RequiresEnv<infer E> ? [options: { env: E }] : [options?: { env?: unknown }]
```

工厂声明携带 RequiresEnv<E>，生成定义在有工厂时携带 `RequiresEnv<MergeEnvironments<Declarations>>`，Declarations 是所选声明的类型元组；没有工厂时不附加该要求，但仍允许宿主统一传 env。是否有工厂按声明标记判断，不能仅按合成结果是否 unknown 判断。对象声明不增加要求；按元组逐项取交集，避免先合成环境类型联合时被 unknown 吸收而丢失其他工厂的要求。

该标记只存在于类型中，不创建运行时 symbol 字段。声明函数区分具体选项对象与工厂重载，不把函数误收为普通对象。

具名 storage、OAuth 等集合由所属能力展开环境要求，不递归猜测任意配置对象里的函数。resources-types 生成类型引用，由 TypeScript 推导；扫描器不启动 TypeScript Program 或求解工厂类型。标准入口直接调用 createApp 并进入统一类型检查，不使用断言跳过宿主环境与定义要求的兼容性检查。

### 实例与所选能力

基础实例提供 fetch、close。fetch 按外部请求执行完整请求链，但不自动为自定义宿主接 WS 升级；close 释放本实例，不关闭外部 Vite/Node 宿主。createApp 不监听端口、不注册退出信号。fetchInternal 是生成页面接入使用的同版本内部接口，应用不自行构造可信身份标记。

所选能力增加直接属性；未选时类型和运行均不存在。ctx.var 沿用 Hono 的请求变量机制，不另套一层服务容器。各入口按实际生命周期区分：

- ctx.var.requestId 属于当前请求，同应用内部调用继承；不作为实例服务
- db、具名 storage 在 ctx.var、实例和 JobContext 中引用所属生命周期的同一资源；Workers 按当前事件绑定
- ctx.var.auth 提供当前身份及登录、退出；instance.auth 只验证凭据，JobContext 不隐式继承请求身份
- ctx.var.visitor 提供当前浏览器标识与 ensure/clear，不提供脱离请求的 visitor 实例；标识本身不授予权限
- ctx.var.stats 可使用当前请求身份；instance.stats 与 JobContext.stats 的去重写入必须显式提供主体
- ctx.var.mfa、ctx.var.webauthn 的登录、挑战和管理操作绑定请求；TOTP 管理使用 ctx.var.totp，维护重加密使用 instance.totp，不在任务中虚构当前登录者
- metrics 在请求、实例及 JobContext 中使用同一所属实例；Node jobs 通过 instance.jobs 管理任务；页面缓存通过 instance.cache 及作用域内失效助手使用
- 日志通过 getLogger 取得并关联当前请求，不额外挂载 ctx.var.logger

这里只规定入口关系，具体操作、启用依赖与平台支持由各专项定义。未启用能力不创建空服务。动态 CORS 回调执行时尚未绑定身份，不承诺读取 auth、visitor 等请求服务；业务中间件、路由与 OAuth 应用回调使用绑定后的 Context。

公开实例不暴露可变 Hono 路由器。路由与策略在创建阶段装配，应用通过文件路由、中间件及自定义宿主接入扩展；宿主所需的路由检查在内部读取同一装配结果，不提供创建后追加路由的接口。

类型推导先生成 resources-types（环境、DB、存储等资源），配置回调仅依赖它与底层契约；随后合成 services-types 和请求上下文。API 类型在 client 的 Register 注册，服务资源在包根的 Register 注册。浏览器类型引用可擦除的 API 类型，不把驱动放进 HTTP 客户端入口。

## 创建顺序与资源责任

1. 生成组合根选择能力与固定顺序；Node 标准宿主先解析 runtime 与 health，再创建应用
2. 解析所属声明并准备完整路由、局部策略和组合约束，在业务资源打开前检查冲突
3. 初始化基础及所选日志输出，再创建数据库、存储等资源，每成功一项立即登记释放
4. 按生成顺序创建服务；认证依次为 session、共同因素协调、TOTP 维护，不建立运行时依赖图
5. 就绪后激活已准备且暂停的任务调度器，宿主监听使用同一份已解析设置

创建失败先取消创建期工作，再按已登记顺序逆序回滚。取消信号不能代替实际释放。借用数据库的因素/统计适配不另建池，也无权关闭共享连接。应用不排列配置导出的初始化顺序。核心不按能力名字扫描全量注册表；生成组合根明确决定装配顺序。

### 专用存取适配的创建

各能力的 StoreDeclaration 是延迟创建约定，工厂在资源就绪后由框架调用。自定义声明提供 create(context)，返回 { value: Store, dispose? } 或其 Promise；value 实现该领域的操作接口，dispose 只释放自己创建的资源。官方 sqlTotp/sqlStats 等也返回同类声明，不在配置时拿连接。

认证 store 的 context 包含 env、resources、resourceDeclarations、target、logger、signal 和 waitUntil，不提供整份 AppInstance 或服务查找器。resources 提供已创建资源，例如 context.resources.db；resourceDeclarations 用于关联数据库声明，target 用于校验平台，waitUntil 跟踪非关键维护工作，并让资源释放等待其结束。signal 属于当前创建宿主或事件，操作期的请求上下文由对应服务另外提供。

所属领域可追加自身初始化所需的有限信息，例如统计 store 的 requirements.unique；这些信息由该领域的类型与创建器拥有，不加入核心的全领域配置联合。借用 db 的适配通常没有 dispose。框架等待 create 完成，取得结果后立即登记其 dispose；后续创建失败时取消创建期工作并逆序回滚。正常关闭同样逆序释放，应用不手工调用 create 或排列顺序。Workers 根据所属事件或连接的真实生命周期释放，不在 Fetch 返回时提前关闭仍在使用的资源。

各类 Store 共用创建与释放约定，保留各自的操作语义。StatsStore、TotpStore、WebAuthnStore、AuthStateStore 和 RecoveryStore 各自保留专用契约；不引入通用 Storage、插件安装或运行时注册中心。

## 请求管线

所有由 Sark 处理的请求先建立执行作用域、请求 ID、基础安全响应头和日志关联；Node 的传输压缩在适用分支包裹响应。随后按目标分支执行：

- 普通 HTTP 和页面：确定客户端地址与外部 origin、注入所选资源、CORS、生命周期准入与 URL 规范化、绑定身份等请求服务、CSRF、有效限流和正文限额、全局/作用域/路由中间件、处理器
- WS 握手：确定客户端地址与外部 origin、注入所选资源、CORS、生命周期准入、绑定身份等请求服务、来源防护与业务中间件；升级前授权，跳过正文限额、压缩和默认 HTTP 限流，不作 308 重定向
- Node 公开构建文件：来源检查、请求 ID、安全头、适用 CORS、访问记录和压缩；跳过业务认证、CSRF、限流和中间件
- CF 公开构建文件：平台直接交付，响应策略使用原生配置，不进入 Worker 或执行应用工厂；动态页面和 API 仍进入应用管线
- Node 运行目录：独立请求分支，执行应用级策略及全局中间件，文件路由优先；不借用 API 树或页面树的目录作用域，授权由明确的应用中间件或下载 API 承担
- Node 探针和指标：经过公共前置处理后进入各自处理器，不经过业务认证和限流；使用各自独立准入
- visitors 初始化、OAuth 入口与回调：按其专项占用真实方法/路径，使用正常请求基础；仅在协议明确需要的边界调整来源规则

基础上下文不执行领域身份检查；预检、排空拒绝和 URL 重定向在请求服务绑定前短路。公共前置处理覆盖 308、预检、401/403、413/429 等提前返回，仍交付适用安全头和请求 ID。Workers 的升级响应不能事后改头，升级前完成响应准备；不把普通 HTTP 的后置写头应用到不可变响应上。

缺少凭据、无效凭据、版本不符或 validate 明确返回 false 时得到匿名身份，由业务授权决定是否拒绝。认证钩子或依赖执行故障向所属错误边界传播，不转换为匿名，也不重复记录日志。CORS、CSRF 与权限检查各守职责，不因一个检查放行就跳过另一个。

HTTP CSRF 的方法、媒体类型、来源允许规则与检查异常边界由 [http.md](http.md) 定义；WS 的 Origin 规则由 [websocket.md](websocket.md) 定义。两者都使用还原后的外部 origin，不能直接比较代理内部 Request.url。Node 响应只在交付层执行一次压缩；显式 compress 中间件选择策略，不额外执行压缩。

Node 从 socket 对端地址起，沿可信代理链从右向左确定客户端地址，并据可信代理提供的信息还原外部 origin。直接接收不可信内网客户端请求时，应用应收紧可信网段或使用空数组。Workers 使用平台提供的来源信息，不采信客户端自填的转发头。完整入口要求见 [deployment.md](deployment.md)。

## SSR 内部与远端调用

同应用 SSR 的 typed client 走进程/事件内 API 分发，不经过 HTTP 回环。它沿用已验证身份、visitor 结果、请求 ID、取消信号、Cookie 汇总和 dedup 作用域。可信标记只在内部传递，不编码为公网可伪造的头。

内部调用跳过网络入口的 CORS、CSRF 和入口流量限制，仍执行目标输入校验、授权、业务配额及中间件。普通浏览器或远端 SSR 请求按真实网络重新验证，不享有内部豁免。

内部 Set-Cookie 逐条合并到当前外层响应，必须在提交头之前完成。Cookie 续期每个外层请求只决定一次，显式登录/退出优先。

页面/API 分离使用 [rendering.md](rendering.md) 的明确传输与身份配置，不在本地 404 时自动改投远端。

## 请求内 dedup

`dedup(fn, key?)` 从包根导入，只包装服务端函数。调用者显式传 DB 等资源；默认按基本值和对象引用比较，需要值等价时传 key 函数。

同一执行作用域内，同函数与等价参数复用同一个 Promise；SSR 内部 API 共享该作用域。跨请求不复用，不合并写操作，不深度序列化。无作用域时按普通函数执行，不回退全局缓存。浏览器 Loader 不导入 dedup。

## Node 监听与生命周期

runtime 从 node 导入 defineNodeRuntime，接受以下选项或返回这些选项的 Env 工厂：

```ts
interface NodeRuntimeConfig {
  port?: number
  hostname?: string
  compress?: boolean | CompressionOptions
  shutdown?: { deadline?: number; reserve?: number }
  probes?: false | { liveness?: string; readiness?: string }
}
```

port、hostname 沿用 Hono Node server 的字段名，仅由标准 Node 生产入口用于监听：

- port 优先使用显式配置，其次读取加载环境后的 PORT，均未提供时使用 3000。只接受 0～65535 的整数；PORT 必须能表示十进制整数，非法值在监听前报错，不回退默认值。0 表示由系统分配端口，启动日志记录实际端口
- hostname 是非空的监听主机名或 IP，不包含协议、端口或路径。省略时沿用 Node listen 的默认绑定：支持 IPv6 时为 `::`，否则为 `0.0.0.0`；需要只允许本机连接时显式指定回环地址。它与限制请求 Host 的 AppConfig.hosts 职责不同
- Node 生产入口先加载环境，由应用创建流程解析一次 runtime 声明并校验。Node 宿主将同一解析结果中的 port、hostname 传给 Hono 的监听器，不重复执行工厂。监听失败则释放已创建资源并以非零码退出
- Vite 开发监听由 vite.config 的 server.host、server.port 管理，不使用 runtime 的监听字段；嵌入外部宿主时由宿主决定监听，createApp 本身不监听端口

字段及绑定行为分别见 [Hono Node server](https://github.com/honojs/node-server#options)、[Node listen](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback) 与 [Vite server 配置](https://vite.dev/config/server-options)。

默认压缩开启；true 或省略采用 gzip 与上游默认阈值，对象提供 CompressionOptions，false 关闭默认策略。CompressionOptions 从 middleware 导出，沿 Hono compress 的参数类型派生，具体覆盖及排除规则见 [http.md](http.md)。探针为 /livez、/readyz，排空总期限 deadline=10000 毫秒、reserve=2000 毫秒，校验 0 < reserve < deadline。

```ts
export const runtime = defineNodeRuntime({
  compress: true,
  shutdown: { deadline: 10000, reserve: 2000 },
  probes: { liveness: '/livez', readiness: '/readyz' },
})
```

省略 probes 使用两个默认路径；对象只覆盖出现字段，省略字段沿用默认；probes=false 关闭整组，不提供单条 false 开关。省略 runtime 仍采用 Node 默认值；health 只增加检查，关闭 probes 却声明 health 报错。

进入 draining 状态后就绪探针立即返回 503，拒绝新业务请求并停止任务触发；在 deadline-reserve 前等待已受理 HTTP、连接回调和任务。等待预算耗尽后发出取消信号、终止传输并记录未结束工作；取消信号不等于 Promise 已结束。之后按剩余时间逆序释放，日志最后刷新。每一步共用剩余预算，close 幂等。

宿主等待超时后先报告失败；尚未结束的处理器或任务仍持有其资源，实际工作结束后才继续清理，不提前将实例标为 closed。

HTTP 连接、WS、任务和驱动分别停止；closeAllConnections 不能代替 WS 关闭。宿主退出和第二次信号处理见部署文档。

## Workers 生命周期与开发替换

Workers 复用静态路由和模块，从本次 Fetch/Scheduled/连接事件绑定 env 与执行作用域。D1/R2 不创建 Node 池；不能永久捕获第一次请求的 binding、秘密或用户信息。

核心作用域使用平台支持的 AsyncLocalStorage.run 等共同能力，不模拟 Promise，不依赖 Workers 未实现的 enterWith/disable。兼容日期及必要兼容标记归 Wrangler。

事件处理器必须等待关键业务完成；允许在响应后完成的非关键维护由宿主通过 executionCtx.waitUntil 跟踪，并遵守平台期限。waitUntil 不提供持久任务或进程式 shutdown 保证。

Node 开发由 Vite 持有 server；应用关闭不退出 Vite。开发实例创建时用当前 Node 环境解析一次 runtime，交接复用 shutdown.deadline/reserve；监听、探针和生产压缩仍由各自宿主负责，不将 runtime 的生产监听设置应用到 Vite。

服务端 HMR 先停止旧实例受理，等待已受理的处理器和响应交付结束，再释放资源、接入新实例。排空预算耗尽后发出取消信号、终止旧实例所属的请求传输并告警，保留 Vite 自身及其他接入的连接；使用同一总期限的剩余时间完成交接。主动取消后的旧工作和资源释放完成即可接入新实例，不将预期取消当作释放故障。

取消后处理器仍未结束，或资源释放失败、超时时，停止本次交接并明确报告，后续请求不再无限等待。宿主继续跟踪真实关闭操作，旧工作仍占用的资源不提前释放；尚未结束的关闭操作完成后才允许创建新实例，真正的释放失败则保持阻断。CF 开发使用官方插件的 workerd 生命周期，不自行建设多代实例平台。
