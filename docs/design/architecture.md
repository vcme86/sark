# 整体架构

## 定位与使用场景

Sark 围绕 Hono、Vite、Node.js 与 React 19 组织全栈能力及外围基础设施。应用声明业务和所需能力，框架完成装配、开发接入和生产交付。

主要使用场景是独立服务器上的单应用。需要本地数据时可以使用 SQLite 和本地文件；需要托管平台时使用 Cloudflare Workers、D1 和 R2。负载增长时，优先复制完整 Node 应用，共用 PostgreSQL 和对象存储。页面与 API 也可以分别部署，通过显式配置的 HTTP 客户端连接。

这些场景不对应一组「小型／大型」模式开关。应用选择资源与部署方式，无须为了将来扩容先安装共享状态服务。框架不包装其他全栈框架，不建设微服务治理、分布式数据库或任意运行时兼容平台。

## 核心、宿主与可选能力

**核心**负责应用创建与释放、执行作用域、取消、HTTP 分发与输入输出、基础请求策略、请求关联和基本日志。这些职责形成一次应用执行的共同约定。

**宿主**负责平台固有行为。Node 负责监听、连接来源识别、进程信号、压缩和基础探针；Workers 负责 Fetch/Scheduled 事件、bindings、平台提供的来源信息及事件执行期限。Vite 负责开发与构建接入，不是第三个生产运行时。

**可选能力**有自己的用途、配置、依赖或资源生命周期，例如数据库、认证、文件存储、任务、入口限流和页面缓存。跨请求计数与后端选择是拆分限流的理由；判断归属还要看用途和平台差异，不能只按是否有状态分类。

页面、SSR、水合与导航是主要产品能力，由页面文件发现结果启用。纯 API 应用不加载 React 和页面运行设施。页面缓存另外声明，页面功能不依赖它。

新增可选能力只扩展所属领域和框架的构建期装配规则，不往核心 AppConfig 增加字段，也不要求应用维护插件列表和初始化顺序。

## 目录与文件职责

以下是新项目的目标组织，仅列出主要目录与文件。sark/ 表示仓库根目录；src、tests、examples 和 docs 均位于仓库根目录下。源码按职责分组；只在相应能力实施时创建实际文件，不预建空模块。

```text
sark/
├── src/
│   ├── core/
│   │   ├── declaration.ts         声明与环境工厂的基础类型
│   │   ├── definition.ts          同版本应用定义的内部构造
│   │   ├── config.ts              defineApp，组合 HTTP 配置
│   │   ├── create.ts              创建实例、登记资源与失败回滚
│   │   ├── context.ts             所属应用、取消与执行作用域
│   │   ├── lifecycle.ts           就绪、排空与逆序释放
│   │   ├── logging.ts             LogTape 基础诊断与关联
│   │   └── types.ts               基础实例及生命周期契约
│   ├── web/
│   │   ├── http/
│   │   │   ├── config.ts          HTTP 选项、默认值与校验
│   │   │   ├── types.ts           endpoint 与 API 类型注册
│   │   │   ├── path.ts            共同路径规则
│   │   │   ├── error.ts           同构 HttpError
│   │   │   ├── cookie.ts          配置感知的 Hono Cookie 接入
│   │   │   ├── server/
│   │   │   │   ├── route.ts       路由声明与类型声明
│   │   │   │   ├── input.ts       正文、查询和参数解析
│   │   │   │   ├── output.ts      JSON 协商与错误响应
│   │   │   │   ├── policy.ts      应用、作用域、路由的策略合并
│   │   │   │   ├── pipeline.ts    已装配请求链的准入与分发
│   │   │   │   ├── context.ts     请求作用域、内部调用和 Cookie 传递
│   │   │   │   ├── dedup.ts       请求内函数结果复用
│   │   │   │   └── sse.ts         事件流、背压与关闭
│   │   │   ├── client/
│   │   │   │   ├── client.ts      typed client 与传输
│   │   │   │   ├── encode.ts      路径、查询、头与正文编码
│   │   │   │   ├── decode.ts      成功与错误解码
│   │   │   │   └── sse.ts         订阅、解析与重连
│   │   │   └── middleware/
│   │   │       ├── cors.ts
│   │   │       ├── csrf.ts
│   │   │       ├── compress.ts
│   │   │       └── rate-limit/    声明、Node 计数、CF binding 与装配
│   │   ├── page/
│   │   │   ├── config.ts          页面 API 传输与身份快照配置
│   │   │   ├── components/        Head、Outlet、Scripts、Link、错误边界、根文档
│   │   │   ├── execution/         匹配、Loader、Action、重新加载与元数据
│   │   │   ├── server/            流式渲染、载荷、样式与 API 传输
│   │   │   │   └── cache/         声明、资格、键、LRU、填充、正文缓冲和失效
│   │   │   ├── browser/           水合、路由视图、导航、历史、守卫和资源准备
│   │   │   ├── context.tsx
│   │   │   ├── hooks.tsx
│   │   │   ├── signals.ts
│   │   │   ├── storage.ts         浏览器 Storage 的 SSR 接入
│   │   │   ├── build.ts
│   │   │   └── types.ts
│   │   ├── ws/                    连接、事件、类型与按需装配
│   │   └── assets/                构建静态交付、Node 目录挂载与装配
│   ├── services/
│   │   ├── auth/
│   │   │   ├── contracts.ts       共享身份、认证结果及资源检查上下文
│   │   │   ├── mfa.ts             共同登录、再次认证与完成协调
│   │   │   ├── challenge.ts       用途、期限、并发验证与尝试次数限制
│   │   │   ├── state/             memory、postgres、d1 短期状态实现
│   │   │   ├── session/           JWT、凭据选择、签发、验证与续期
│   │   │   ├── oauth/             openid-client、事务 Cookie 与厂商差异
│   │   │   ├── totp/              OTP 接入、因素管理、加密与存取
│   │   │   │   └── db/            SQLite、PostgreSQL、D1 适配及 schema
│   │   │   ├── webauthn/          注册、认证、凭据、浏览器接入与存取
│   │   │   │   └── db/
│   │   │   └── recovery/
│   │   │       ├── service.ts     恢复码签发与单次消费
│   │   │       └── db/            SQLite、PostgreSQL、D1 适配及 schema
│   │   ├── db/                    SQLite、PostgreSQL、D1 声明与资源
│   │   ├── storage/               local、r2、s3 后端及独立 presign 接入
│   │   ├── visitors/              声明、Cookie 身份与初始化端点
│   │   ├── stats/                 具名计数、主体解析、专用存取与 SQL 适配
│   │   └── jobs/                  共同执行、Node 调度、CF 事件映射
│   ├── observability/
│   │   ├── logging/               完整日志配置、输出与访问记录
│   │   ├── metrics/               Node Registry、运行时采集与导出
│   │   └── health/                readiness 检查、缓存与独立准入
│   ├── tooling/
│   │   ├── build/
│   │   │   ├── discover/          配置导出、路由、页面和冲突
│   │   │   ├── generate/          应用、类型、浏览器及宿主入口
│   │   │   ├── capabilities.ts    官方能力的构建期装配登记
│   │   │   ├── project.ts         按运行端筛选构建数据
│   │   │   ├── bundle.ts
│   │   │   └── types.ts
│   │   ├── vite/                  插件、Node 开发、CF 官方插件与 HMR
│   │   └── cli/                   generate、dev、build、start 命令
│   ├── adapter/
│   │   ├── node/                  runtime 配置、监听、来源、升级、env 和基础探针
│   │   └── cloudflare/            Fetch、Scheduled、bindings、升级和事件执行期限
│   └── entries/                   按公开子路径组织的薄导出
├── tests/
│   ├── unit/
│   ├── contract/                  公开类型、协议、存取契约和生命周期
│   ├── integration/
│   ├── e2e/
│   └── fixtures/                  最小应用与独立客户端工程
├── examples/                      使用示例，不代替测试夹具
├── docs/                          设计文档
└── package.json                   包元数据、公开导出与标准命令
```

文件按一项完整职责组织，可以包含多个协作函数。需要进一步分组时才建目录，不要求相邻模块深度一致。每项能力的配置、类型、运行代码和构建片段相邻维护；构建片段不由运行入口导出。

services/db 负责数据库声明、连接及资源生命周期；认证模块内的 db 目录负责所属领域的数据库存取适配与 schema，借用已声明的数据库，不另建连接。内部目录名不决定公开包路径；auth/totp/sqlite 等入口仍按具体后端交付。

## 依赖方向

生成的应用定义是组合根，显式引用所选核心、领域能力和宿主。核心使用这些装配结果，不维护包含所有能力的配置联合或运行时注册表。

- 领域运行代码依赖必要的底层契约和上游库，不导入生成组合根
- 页面只依赖 HTTP 客户端与协议；HTTP 不依赖页面
- 同构 Loader 与 Action 不导入 HTTP 服务端、数据库和身份初始化服务
- 第一方 session 不导入 OAuth、TOTP、WebAuthn；MFA 使用 session 的会话契约及注入的认证因素验证器
- 配置回调使用资源类型，实例服务在后续合成，避免资源 → 服务 → 配置的类型循环
- 运行代码不导入 Vite、构建片段或 CLI；浏览器不导入服务端配置和驱动
- 分组目录不建立提前加载所有子能力的聚合 index

page 公开入口仅含同构信号、类型和 definePage 纯声明构造，允许 Loader/浏览器导入，不加载应用配置、驱动或服务初始化；client 复用同一信号实现。

全部配置入口及后续能力遵循 [configuration.md](configuration.md) 的解析、合并与传递机制。各领域在所属入口提供完整的已解析配置，下游直接消费，不自行补默认值或掩盖配置缺失。

HTTP 默认值由 web/http/config 唯一维护；core/config 组合它。policy 只应用局部覆盖；create 负责创建与生命周期；pipeline 执行已经确定的请求链。

## 公开包入口

一个 npm 包通过显式 exports 交付。源码分组、应用配置导出和包子路径不一一对应。以下按用途列出入口及主要运行时导出；选项、上下文、服务接口和协议类型由对应专项定义，不在这里重复全部类型清单。

- `server`：defineApp、createApp、route、HttpError、z、dedup、getLogger，以及 getCookie、setCookie、deleteCookie、getSignedCookie、setSignedCookie
- `http`：createClient、HttpError 与协议类型；无 React 依赖
- `client`：Head、Outlet、Scripts、Link、useClient、useAction、useNavigate、useNavigation、useBlocker、reload、setIdentity、redirect、notFound；复用同一 HTTP 客户端，具体契约见 [pages.md](pages.md)
- `page`：definePage、redirect、notFound 及页面类型；`page/cache`：definePageCache、revalidatePath、revalidateTag 及缓存类型
- `server/node`：defineNodeRuntime 与 NodeRuntimeOptions；`assets/node`：defineAssets
- `db/sqlite`、`db/postgres`、`db/d1`：各自的 defineDatabase
- `storage/local`：defineStorage、saveUploadFile；`storage/r2`、`storage/s3`：各自的 defineStorage；`storage/presign`：definePresign
- `auth/session`：defineAuth、signToken、verifyToken、requireStepUp 及会话类型
- `auth/oauth`：defineOAuth；`auth/totp`：defineTotp；`auth/webauthn`：defineWebAuthn；`auth/mfa`：defineMfa、memoryState 及共同认证契约。WebAuthn 浏览器接入从 `auth/webauthn/browser` 导入，具体符号由 [webauthn.md](webauthn.md) 定义
- `auth/state/postgres`、`auth/state/d1`：各自的 sqlAuthState
- `visitors`：defineVisitors；`visitors/browser`：ensureVisitor
- `stats`：defineStats 与计数契约；`stats/sqlite`、`stats/postgres`、`stats/d1`：sqlStats
- `jobs`：defineJobs；`logging`：defineLogging；`metrics`：defineMetrics；`health`：defineHealth，及各自的选项、服务和上下文类型
- `middleware`：cors、csrf、compress；`middleware/rate-limit`：defineRateLimit 声明、rateLimit 中间件及其选项类型
- `vite`：sark；`utils`：parseCookie、parseSignedCookie、serializeCookie、serializeSignedCookie 及相关类型，确切契约见 [http.md](http.md)

认证 SQL 适配与 schema 的精确路径分别由 [mfa.md](mfa.md)、[totp.md](totp.md)、[webauthn.md](webauthn.md) 定义；统计 schema 路径由 [stats.md](stats.md) 定义。这些路径在 package.json 中逐项枚举，不使用顶层通配符暴露内部文件。

恢复码的运行代码和 SQL 实现集中在 services/auth/recovery，对外仍由共同 MFA 的 auth/mfa 子路径交付；应用不额外声明 recovery；这样分组也不会额外产生一个提前加载全部内容的聚合入口。

`runtime/core`、`runtime/node`、`runtime/cloudflare`、`runtime/page-server`、`runtime/page-browser`、`runtime/websocket`、`runtime/jobs-node`、`runtime/jobs-cloudflare` 仅供同版本生成物接入。应用使用生成的定义，不手写这些内部装配字段。

## 上游与框架承担的工作

Hono 提供路由、中间件、Cookie、JWT 和流传输；Vite 提供解析、模块图和构建；React 提供渲染与水合。Sark 完成声明、作用域、装配和完整链路。

Drizzle 保留真实驱动 API；openid-client 负责标准 OAuth/OIDC；otplib 与 SimpleWebAuthn 负责相应认证协议；Croner 负责 Node 日历调度与控制；LogTape 负责日志；lru-cache 负责页面内存存储；Prometheus 客户端负责 Node 计量与运行时采集。各专项说明 Sark 需要补充的领域规则，不维护等价的第二套上游实现。

## 未使用能力的行为

未启用的增强不出现在 AppConfig 提示中，不生成服务字段，不加载 SDK，不创建连接、计时器、Cookie、表或浏览器脚本。启用条件及必要的默认组合由所属专项明确规定。开发包磁盘中可以存在未使用的代码，应用运行产物不能因此提前加载它。

基础日志与 Node 基础探针是明确的默认行为；完整访问日志、依赖检查、文件输出和页面存储分别声明。类型、生成代码与实际运行必须表达同一个启用结果，不提供只会抛错的占位服务，也不提供静默的空实现。
