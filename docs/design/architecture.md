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

## 公开包入口

包根 `@olivaw/sark` 提供应用核心 API，子路径按完整使用场景、独立能力和实际依赖边界组织。根入口适用于 Node 和 Workers，不是浏览器通用入口，也不聚合所有增强。内部目录按实现职责组织，不逐项映射为公开子路径；entries 直接筛选所属实现，不建立 index 转发链。

同组能力没有额外 SDK 或资源初始化边界时适当聚合，如页面组件与声明、Node 宿主声明、访客声明与浏览器助手。数据库驱动、认证 SQL 后端、浏览器凭据 SDK 和可选签名仍保持隔离；不能依赖应用构建裁剪来保证原生 ESM 不加载未选后端。

一个 npm 包通过显式 exports 交付。package.json 与构建入口按相同用途排序：应用核心与 Node 宿主、页面与 HTTP 客户端、中间件、数据库、存储、认证、订阅、日志、任务、访客与计数、构建工具；内部 runtime 入口统一放在最后。不提供空的 db/storage 父入口，也不保留旧路径别名。组内先列主入口，再紧邻列出子入口；同类后端统一按 SQLite、PostgreSQL、D1，存储按 local、s3、r2、presign 排列。以下列出主要导出，精确类型由对应专项定义：

### 应用核心与宿主

- `.`：defineApp、createApp、route、z、SOCKET_READY_STATE、HttpError、请求 Cookie 助手、dedup、getLogger；Context、MiddlewareHandler 保留本应用声明的资源与请求服务类型，Register 注册这些资源与服务
- `node`：defineNodeRuntime、defineAssets、defineHealth、defineMetrics 及其类型；Prometheus 实现仅在声明 metrics 时装配

### 页面与 HTTP 客户端

- `page`：definePage、DefaultRoot、Head、Outlet、Scripts、Link、错误边界、useClient、useAction、useNavigate、useNavigation、useBlocker、reload、setIdentity、redirect、notFound 及页面类型；具体契约见 [pages.md](pages.md)
- `client`：createClient、HTTP/SSE/WS 客户端契约、HttpError、API Register，以及 parseCookie、parseSignedCookie、serializeCookie、serializeSignedCookie；不加载 React，确切契约见 [http.md](http.md)

### 可选扩展

- `page/cache`：服务端 definePageCache、revalidatePath、revalidateTag 及缓存类型；不进入浏览器 page 入口
- `middleware`：cors、csrf、compress、defineRateLimit、rateLimit 及其类型
- `db/sqlite`、`db/postgres`、`db/d1`：各自的 defineDatabase；不设置默认数据库
- `storage/local`：defineStorage、saveUploadFile 及本地文件契约
- `storage/s3`、`storage/r2`：各自的 defineStorage 与对应对象存储契约
- `storage/presign`：独立启用的 definePresign，不是第四种存储后端
- `auth`：defineAuth、signToken、verifyToken、requireStepUp 及第一方认证与会话类型；不加载其他认证增强
- `auth/oauth`：defineOAuth 及第三方登录契约
- `auth/mfa`：defineMfa、memoryState 及共同认证契约
- `auth/totp`：defineTotp 及 TOTP 契约
- `auth/totp/sqlite`、`auth/totp/postgres`、`auth/totp/d1`：sqlTotp、totpFactors
- `auth/webauthn`：defineWebAuthn 及 WebAuthn 契约
- `auth/webauthn/browser`：浏览器凭据交互 SDK 接入，具体符号见 [webauthn.md](webauthn.md)
- `auth/webauthn/sqlite`、`auth/webauthn/postgres`、`auth/webauthn/d1`：sqlWebAuthn、webauthnSubjects、webauthnCredentials
- `auth/recovery/sqlite`、`auth/recovery/postgres`、`auth/recovery/d1`：sqlRecovery、recoveryCodeSets
- `auth/state/postgres`、`auth/state/d1`：sqlAuthState、authChallenges、authAttemptWindows
- `feeds`：defineFeeds、原生订阅数据与发布契约，见 [feeds.md](feeds.md)
- `logging`：defineLogging 及输出配置
- `jobs`：defineJobs 及任务契约
- `visitors`：defineVisitors、ensureVisitor、VisitorError 及请求和浏览器初始化契约
- `stats`：defineStats 与计数契约
- `stats/sqlite`、`stats/postgres`、`stats/d1`：sqlStats 与默认表定义

### 构建工具

- `vite`：sark 构建插件

认证能力声明可以使用自定义 store；各 SQL 后端入口只提供所属适配及表定义，不重复提供声明构造，也不聚合兄弟后端或其他因素。服务端配置按需分别选择能力与后端。WebAuthn 浏览器 SDK 与后端实现分开，普通页面不加载该 SDK。

浏览器可导入 page、client、visitors 和 auth/webauthn/browser；包根、node、feeds、middleware、auth 及其余后端、jobs、logging、stats 及其 SQL 后端、db、storage、vite 和 page/cache 是服务端或工具入口。类型导入按 TypeScript 正常擦除；库的纯声明不包含秘密，应用 app.ts 中的实际秘密配置仍只在服务端。浏览器构建检查完整入口与子路径边界，不用条件导出让同一路径在两端交付不同 API。

认证 SQL 适配与 schema 的精确路径分别由 [mfa.md](mfa.md)、[totp.md](totp.md)、[webauthn.md](webauthn.md) 定义；统计 schema 路径由 [stats.md](stats.md) 定义。这些路径在 package.json 中逐项枚举，不使用顶层通配符暴露内部文件。

恢复码的运行代码和 SQL 实现集中在 features/auth/recovery；恢复契约由 auth/mfa 交付，SQL 适配与表定义由独立 auth/recovery 后端入口交付。应用通过 mfa.recovery 选择它，不额外声明顶层 recovery。共同短期状态服务于绑定、第二步及无密码认证，不属于某一种因素。

### 内部装配入口

`runtime/core`、`runtime/node`、`runtime/cloudflare`、`runtime/page-server`、`runtime/page-browser`、`runtime/page-cache`、`runtime/rate-limit`、`runtime/auth`、`runtime/oauth`、`runtime/mfa`、`runtime/totp`、`runtime/webauthn`、`runtime/feeds`、`runtime/storage`、`runtime/logging`、`runtime/health`、`runtime/metrics`、`runtime/jobs-node`、`runtime/jobs-cloudflare`、`runtime/visitors`、`runtime/stats` 仅供同版本生成物接入。应用使用生成的定义，不手写这些内部装配字段。

## 依赖方向

生成的应用定义是组合根，显式引用所选核心、领域能力和宿主。核心使用这些装配结果，不维护包含所有能力的配置联合或运行时注册表。

ServiceAssembly 提供准备、创建和请求绑定契约，不声明依赖图。生成器检查固定能力组合并输出创建顺序：auth → mfa → totp 维护；运行时直接消费该顺序，不重复检查因素集合或排序。应用不通过配置导出顺序安排这些内部步骤。

已启用的服务可以随创建结果提供固定的同步执行观察者，由同一次装配收集、随实例或事件传递。HTTP/WS 和任务模块在已有完成点通知执行事实，具体计量归所属服务；核心不依赖指标名或 SDK。观察者不接管工作和资源生命周期，不增加应用配置、任意事件、运行时订阅或请求级服务扫描。

- 领域运行代码依赖必要的底层契约和上游库，不导入生成组合根
- 页面传输复用 client 与共享 HTTP 协议；服务端渲染接入应用的执行作用域、日志与页面终端契约，app/http 不导入页面实现
- 页面可按用途引用应用声明和路由类型；浏览器运行代码不导入应用执行器、平台适配或可选能力的初始化实现
- 同构 Loader 与 Action 不导入 HTTP 服务端、数据库和身份初始化服务
- 第一方 session 不导入 OAuth、TOTP、WebAuthn；MFA 使用 session 的会话契约及注入的认证因素验证器
- 配置回调使用资源类型，实例服务在后续合成，避免资源 → 服务 → 配置的类型循环
- 运行代码不导入 Vite、构建片段或 CLI；浏览器不导入服务端配置和驱动
- 分组目录不建立提前加载所有子能力的聚合 index

路由装配按已有 declaration 或 pageHandler 选择普通 HTTP 处理与页面渲染，不额外维护业务用途分类。

HTTP 路由装配与页面终端的共同契约放在 app/http/assembly.ts，装配器和领域端点不从执行器文件借用类型。页面的导航、作用域快照和 Action 结果等共同类型放在 page/types.ts；React Context 负责向组件树交付这些状态，不作为页面执行器或启动载荷的类型来源。

page 公开入口统一提供页面声明、React 组件、Hooks 和同构信号，允许 SSR、Loader 与浏览器导入，不加载应用秘密配置、驱动或服务初始化。导入 definePage 也会加载页面组件及 React；纯 API 应用与独立 HTTP 消费方不导入 page。HTTP 客户端由 client 提供，页面 useClient 复用同一实现与 API 类型注册。

全部配置入口及后续能力遵循 [configuration.md](configuration.md) 的解析、合并与传递机制。各领域在所属入口提供完整的已解析配置，下游直接消费，不自行补默认值或掩盖配置缺失。

app/config.ts 统一定义 AppConfig、应用声明、已解析配置、默认值与解析函数；defineApp 保存声明，resolveAppConfig 求值后调用 resolveHttpConfig，完整结果交给下游。app/http/policy 只应用局部覆盖；app/create 负责创建与生命周期；app/http/pipeline 执行已经确定的请求链。

app/http 直接使用内建 CORS、CSRF；这两个中间件读取 app/context 识别内部调用和执行来源，不调用应用创建。可选 rate-limit 的实现归 middleware/rate-limit，app/http 只消费已准备的 RouteAdmission 和必要类型。依赖按具体职责判断，不强制所有目录形成单向层级。

共享 http 保存 Endpoint、HttpMethod、Jsonify 等协议类型及路径、URL、错误、ETag 和资源描述，不依赖应用初始化。client 独立实现 HTTP/SSE/WS 传输，客户端入口可以类型导出服务端路由的派生契约，不将其变为运行时导入。

## 目录与文件职责

以下列出主要目录与文件。sark/ 表示仓库根目录；src、tests、examples 和 docs 均位于仓库根目录下，源码按职责分组。

```text
sark/
├── src/
│   ├── app/                            应用运行时
│   │   ├── config.ts                   原始配置、声明、完整结果与解析
│   │   ├── create.ts                   创建实例、执行接入与失败回滚
│   │   ├── definition.ts               同版本应用定义的内部构造
│   │   ├── context.ts                  所属应用、取消与执行作用域
│   │   ├── declaration.ts              声明与环境工厂的基础类型
│   │   ├── dedup.ts                    请求内函数结果复用
│   │   ├── lifecycle.ts                就绪、排空与逆序释放
│   │   ├── logging.ts                  LogTape 基础诊断与关联
│   │   ├── resource.ts                 资源创建、交付与释放契约
│   │   ├── service.ts                  服务准备、创建与请求绑定契约
│   │   ├── store.ts                    专用存取的延迟创建与释放契约
│   │   ├── types.ts                    基础实例、生命周期与资源注册
│   │   └── http/                       服务端 HTTP 声明、装配与执行
│   │       ├── types.ts                上下文、路由声明与 endpoint 派生
│   │       ├── assembly.ts             路由装配、入口准入与页面终端契约
│   │       ├── route.ts                路由、SSE 与 WebSocket 声明
│   │       ├── schema.ts               输入 schema 及验证接口选择
│   │       ├── body-limit.ts           正文长度检查与流式计数
│   │       ├── input.ts                正文、查询和参数解析
│   │       ├── output.ts               JSON 协商与错误响应
│   │       ├── policy.ts               应用、作用域、路由的策略合并
│   │       ├── pipeline.ts             已装配请求链的准入与分发
│   │       ├── request-context.ts      请求作用域、来源解析和响应头
│   │       ├── delivery.ts             响应正文与实际交付完成跟踪
│   │       ├── public.ts               宿主交付的公开请求元数据
│   │       ├── proxy.ts                可信代理规则编译与匹配
│   │       ├── cookie.ts               配置感知的 Hono Cookie 接入
│   │       ├── sse.ts                  事件流、背压与关闭
│   │       └── websocket.ts            升级准备、连接状态与回调执行
│   ├── http/                           跨工具链、运行时及客户端的共同规则
│   │   ├── types.ts                    Endpoint、HttpMethod 与 Jsonify
│   │   ├── path.ts                     文件路由、匹配与请求路径规则
│   │   ├── url.ts                      两端 URL 规范化规则
│   │   ├── error.ts                    同构 HttpError
│   │   ├── etag.ts                     ETag 与条件请求
│   │   ├── defaults.ts                 共用默认值
│   │   └── assets.ts                   静态资源与构建产物描述
│   ├── client/                         独立 HTTP 客户端
│   │   ├── client.ts                   类型安全调用、传输与 API Register
│   │   ├── encode.ts                   路径、查询、头与正文编码
│   │   ├── decode.ts                   成功与错误解码
│   │   └── sse.ts                      订阅、解析与重连
│   ├── middleware/
│   │   ├── cors.ts                     CORS 类型与内建处理
│   │   ├── csrf.ts                     来源与请求凭据防护
│   │   ├── compress.ts                 显式压缩中间件
│   │   ├── compression.ts              Node 与中间件共用的压缩配置解析
│   │   └── rate-limit/                 声明、继承、Node 计数与 CF binding
│   ├── page/
│   │   ├── config.ts                   页面 API 传输与身份快照配置
│   │   ├── bootstrap.ts                SSR 与浏览器共用的启动载荷契约
│   │   ├── components/                 Head、Outlet、Scripts、Link、错误边界、根文档
│   │   ├── match.ts                    路由匹配与参数解码
│   │   ├── meta.ts                     元数据合并
│   │   ├── serialize.ts                启动载荷序列化
│   │   ├── server/                     流式渲染、载荷、样式与 API 传输
│   │   │   ├── response-policy.ts      API 响应对外层页面缓存的限制
│   │   │   └── cache/                  声明、资格、键、LRU、填充与失效
│   │   ├── browser/                    水合、路由视图、导航、历史、守卫和资源准备
│   │   ├── context.tsx
│   │   ├── hooks.tsx
│   │   ├── signals.ts
│   │   ├── storage.ts                  浏览器 Storage 的 SSR 接入
│   │   ├── build.ts
│   │   └── types.ts
│   ├── adapter/
│   │   ├── node/                       runtime、监听、来源、升级、env、探针与目录挂载
│   │   └── cloudflare/                 Fetch、Scheduled、bindings、升级和事件执行期限
│   ├── features/                       独立可选的功能模块，无全量加载入口
│   │   ├── auth/
│   │   │   ├── contracts.ts            共享身份、认证结果及资源检查上下文
│   │   │   ├── factor.ts               因素验证、请求绑定和创建契约
│   │   │   ├── verification.ts         共同证明消费与会话完成
│   │   │   ├── error.ts                因素认证错误分类
│   │   │   ├── mfa/                    共同登录、再次认证、挑战策略与完成协调
│   │   │   ├── state/                  memory、postgres、d1 短期状态及 SQL schema
│   │   │   ├── session/                JWT、凭据选择、签发、验证与续期
│   │   │   ├── oauth/                  openid-client、事务 Cookie 与厂商差异
│   │   │   ├── totp/                   OTP 接入、因素管理、加密与存取
│   │   │   │   ├── db/                 SQLite、PostgreSQL、D1 存取适配
│   │   │   │   └── schema/             各后端的 Drizzle 表定义
│   │   │   ├── webauthn/               注册、认证、凭据、浏览器接入与存取
│   │   │   │   ├── db/
│   │   │   │   └── schema/
│   │   │   └── recovery/
│   │   │       ├── service.ts          恢复码签发与单次消费
│   │   │       ├── db/                 SQLite、PostgreSQL、D1 存取适配
│   │   │       └── schema/             各后端的 Drizzle 表定义
│   │   ├── feeds/                      原生订阅文档声明、生成与发布端点
│   │   ├── visitors/                   声明、访客标识、初始化端点与浏览器助手
│   │   ├── stats/                      具名计数、主体解析、专用存取与 SQL 适配
│   │   ├── db/                         数据库声明、资源及共用表映射/关联助手
│   │   ├── storage/                    local、s3、r2 后端及独立 presign 接入
│   │   ├── jobs/                       共同执行、Node 调度、CF 事件映射
│   │   ├── logging/                    完整日志配置、输出与访问记录
│   │   ├── metrics/                    Node Registry、运行时采集与导出
│   │   └── health/                     readiness 检查、缓存与独立准入
│   ├── tooling/
│   │   ├── config.ts                   工程选项、目录与前缀解析
│   │   ├── build/
│   │   │   ├── discover/               配置导出、路由、页面和冲突
│   │   │   ├── generate.ts             应用、类型、浏览器及宿主入口生成
│   │   │   ├── project.ts              按有效工程配置发现、校验并生成
│   │   │   ├── assets.ts               开发与生产资源清单
│   │   │   └── cloudflare-assets.ts    Workers Static Assets 规则与响应头
│   │   ├── vite.ts                     插件、Node 开发、CF 官方插件与 HMR
│   │   └── cli.ts                      generate、dev、build、start 命令
│   └── entries/                        集中筛选公开符号，直接导出所属实现
│       ├── root.ts                     包根：应用创建、路由、上下文与请求助手
│       ├── node.ts                     Node runtime、目录挂载与健康检查声明
│       ├── page.ts                     页面声明、React 组件、Hooks 与信号
│       ├── client.ts                   HTTP 客户端、协议类型与纯 Cookie 工具
│       ├── middleware.ts               HTTP 中间件与限流声明
│       ├── db/                         数据库后端入口
│       ├── storage/                    存储后端与可选签名入口
│       ├── auth.ts                     第一方认证与会话
│       ├── auth/                       认证增强与各后端的具名入口文件
│       ├── feeds.ts                    内容订阅声明与类型
│       ├── logging.ts
│       ├── jobs.ts
│       ├── visitors.ts                 访客声明、请求契约与浏览器初始化
│       ├── stats.ts                    业务计数声明、错误类型与契约
│       ├── stats/                      SQLite、PostgreSQL、D1 存取适配与 schema
│       ├── vite.ts
│       └── runtime/                    同版本生成代码的内部接入
├── tests/
│   ├── unit/
│   ├── contract/                       内存协议、存取契约和生命周期
│   │   └── types/                      独立编译的类型契约
│   ├── integration/                    真实宿主、构建产物及工程流程
│   ├── e2e/
│   ├── fixtures/                       固定数据、最小应用和独立客户端输入
│   └── helpers/                        生成、编译、启动与清理助手
├── examples/                           使用示例，不代替测试夹具
├── docs/                               设计文档
└── package.json                        包元数据、公开导出与标准命令
```

文件按一项完整职责组织，可以包含多个协作函数。需要进一步分组时才建目录，不要求相邻模块深度一致。每项能力拥有配置、类型和运行代码；生成器在普通能力分支集中组织关联输出，不建立能力注册中心或装配 DSL。普通资源和服务使用既有装配契约；只有真实宿主、HTTP 接入需要的准备结果保留具名字段。

features/db 负责数据库声明、连接及资源生命周期；认证模块内的 db 目录负责所属领域的存取适配，schema 目录保存相应表定义。适配借用已声明的数据库，不另建连接。SQLite/D1 共用 SQLite 表定义及 TOTP、恢复码、WebAuthn 领域查询，直接使用 Drizzle 的 sync/async SQLite API；PG 保留独立表和查询。AuthState 保留 PG 事务/行锁与 D1 条件更新/batch，不用通用 SQL 抽象抹平原子语义。

## 命名约定

名称依据实际对象、职责、生命周期和存储单位选择，同一概念在定义、导出和消费处使用相同名称。内部局部变量可以利用所属模块的上下文缩短；自有符号在公开入口直接按定义名导出，不另造一套短名/全名。上游通用符号可以按用途限定，如 `parse` → `parseCookie`；导入同名符号或区分测试中的默认/自定义对象时，允许有实际区分作用的局部别名。

- 目录按职责命名，如 app、http、client、middleware、page、auth；集合名称沿用所属领域与项目惯例，如 features、entries。平台适配使用既有 adapter，不强制全部目录采用单数或复数。文件使用小写和连字符，以实际内容命名；不为统一字面形式改变已有职责划分或增加目录层级
- TypeScript 类型、类与组件使用 PascalCase，函数、字段和变量使用 camelCase，模块级固定默认值使用 UPPER_SNAKE_CASE。App、Auth、Http、Sql、Totp 等自有领域词按既有惯用缩写统一，如 AuthFacts、AuthFlow、Identity.auth；OAuth、WebAuthn、D1、S3、R2 及上游公开类型保留专名或原名。动作短语按语义命名，如 completeAuthentication，authenticate 等动词不机械截短
- Config 表示能力或应用声明配置，ResolvedConfig 表示默认值和校验已完成的配置；Options 表示调用控制项或上游接入选项，Input 表示调用方资料，Args 表示框架回调参数，Context 表示执行设施。名称先体现实际用途，不给所有对象机械添加后缀
- Declaration 表示延迟声明，Assembly 表示内部装配，InitResult 表示创建结果。RequestAuth、RequestVisitor、RequestMfa 等 Request 前缀表示请求绑定接口；实例维护单独命名，如 TotpMaintenance。认证请求接口的实现使用 MfaService 等领域服务名；类型后缀表达实际角色，不使用 PublicInstance 等泛称
- 动作函数以动词表达实际行为，如 listPublicFiles、createProductionAssets、writeBuildAssets；资源名称覆盖真实使用范围，纯 API 应用也使用的构建产物不冠以 page。登录统一使用 signIn、beginSignIn 与 SignInResult 等词根，协议规定的字段和上游动作名称保持原名
- 持久化类型和表名反映实际存储单位：认证尝试记录是账户/用途的计数窗口，恢复码记录是一组带版本的摘要集合。默认 schema 使用 authAttemptWindows、recoveryCodeSets 等同名定义和导出；SQL 使用对应 snake_case 复数表名，索引采用所属表名、索引列和 idx 后缀
- 领域限定词用于区分实际对象，如 authChallenges、totpFactors；不添加框架品牌前缀。标准协议字段、上游类型、平台 binding 与浏览器共享命名空间按其契约保留，不为形式一致改写外部协议

## 上游与框架承担的工作

Hono 提供路由、中间件、Cookie、JWT 和流传输；Vite 提供解析、模块图和构建；React 提供渲染与水合。Sark 完成声明、作用域、装配和完整链路。

Drizzle 保留真实驱动 API；openid-client 负责标准 OAuth/OIDC；otplib 与 SimpleWebAuthn 负责相应认证协议；Croner 负责 Node 日历调度与控制；LogTape 负责日志；lru-cache 负责页面内存存储；Prometheus 客户端负责 Node 计量与运行时采集。各专项说明 Sark 需要补充的领域规则，不维护等价的第二套上游实现。

## 未使用能力的行为

未启用的增强不出现在 AppConfig 提示中，不生成服务字段，不加载 SDK，不创建连接、计时器、Cookie、表或浏览器脚本。启用条件及必要的默认组合由所属专项明确规定。开发包磁盘中可以存在未使用的代码，应用运行产物不能因此提前加载它。

基础日志与 Node 基础探针是明确的默认行为；完整访问日志、依赖检查、文件输出和页面存储分别声明。类型、生成代码与实际运行必须表达同一个启用结果，不提供只会抛错的占位服务，也不提供静默的空实现。
