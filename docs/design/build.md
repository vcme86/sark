# 构建、发现与生成

## 配置归属

Vite 提供工程根目录、输出目录、publicDir、模块图与构建。Sark 插件只配置文件发现、挂载前缀和目标，不保存认证秘密或业务资源。

```ts
import { sark } from '@olivaw/sark/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: 'public',
  build: { outDir: 'dist' },
  plugins: [react(), sark({ target: 'node' })],
})
```

Sark 工程选项：

```ts
interface SarkOptions {
  target?: 'node' | 'cloudflare'
  appEntry?: string
  apiDir?: string | false
  apiPrefix?: string
  webDir?: string | false
  webPrefix?: string
  apiTypes?: string
}
```

默认 target=node、appEntry=app.ts、apiDir=api、apiPrefix=/api、webDir=app、webPrefix=/。不存在的页面/API 目录没有发现项；false 显式关闭相应扫描。apiTypes 是分离部署时导出 Api 类型的模块名，类型导入不加载远端服务实现；与本地 API 类型来源同时指定时报错。

publicDir 直接使用 Vite 的配置解析结果，关闭时不扫描或复制 public。静态目录名称由 Vite 配置决定，不增加另一份 staticDir。

### 配置解析与传递

共同机制见 [configuration.md](configuration.md)。插件入口集中补齐并校验 Sark 工程选项，产生内部已解析配置，再绑定 Vite 最终解析的根目录、base、publicDir 和目标输出信息；Wrangler 配置使用官方接入所选环境的有效结果。apiDir/webDir 的 false 保留关闭含义；URL 前缀在入口规范化，根前缀保留 `/`。

发现、生成、开发分发、HMR 和 CLI 直接使用这份结果，不分别补 target、目录或前缀默认值。可独立调用的工程生成入口也经过同一解析流程；框架内部不重复解析原始选项。

绑定项目根目录后，工程配置只向下游交付一份有效形态：发现目录和生成目录为绝对路径，前缀已规范化，相对 API 类型模块已转成相对于生成目录的导入路径。不再同时保留嵌套原选项和同名绝对路径，也不让下游重新绑定 webDir 或 apiTypes。

发现和生成由 tooling/build/project.ts 组织，CLI 与 Vite 插件直接复用。插件只接入 Vite 生命周期，CLI 不经插件实现模块取得生成能力。

API 发现路径、生成的相对 API 类型键及框架绑定客户端基址共同使用 apiPrefix；页面发现、服务端匹配和浏览器路由共同使用 webPrefix。base 决定构建资源 URL，不隐式替代或再次叠加 API、页面前缀。

webPrefix 限定网站页面路由及其 HTML 404 的路径范围，apiPrefix 与其独立，不相互叠加；静态资源仍使用 Vite base。

Node 在 Vite 配置解析完成后执行发现与生成，不额外执行早期生成。Workers 的官方插件要求早期已有入口，因此先生成该阶段所需文件，最终配置确定后完成路径绑定和后续生成；两个阶段复用已解析的 Sark 选项及同一生成实现。不能把暂定路径传给最终宿主，也不能删除必要的 Workers 早期生成导致首次构建失败。

## 应用入口发现

使用 Vite 8 公开 parseSync 读取模块导出，使用插件 this.resolve 或公开 createIdResolver 跟随正常文件与别名引用。不启动 TypeScript Program，不分析配置函数体，不执行环境工厂。

parseSync 调用形态为 `parseSync(filename, sourceText, options?)`，返回 ParseResult；AST 从 program 取得，解析错误从 errors 处理，不把返回值当成直接的 Program。[Vite 导出](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/index.ts)、[Rolldown ParseResult](https://rolldown.rs/reference/Interface.ParseResult)

支持直接具名声明、局部变量显式别名导出和显式再导出；普通 JS/TS ESM 均按目标解析条件处理。纯类型导出不启用能力。入口 default、export star、动态 CommonJS、namespace 能力集合、未知运行导出，以及自定义虚拟模块生成的配置入口均给出带位置的错误。

`defineAuth(getOptions())` 属于正常配置表达式，生成器只识别 auth 导出；有效性由类型检查及运行前声明校验负责。首次 generate 不要求生产秘密，不要求生成物先存在才能检查。

## 文件分类与目录作用域

扫描相对于各自配置的 API 树、页面树执行：

- 页面发现 `.tsx/.jsx`。先识别精确的 _root、_layout、_error 保留文件及 _middleware.ts/.js，再发现普通页面
- API 发现带 get/query/post/put/patch/delete/options/all/ws/sse 后缀的 JS/TS 模块；无这些后缀的辅助模块不生成路由
- 两棵树中，其余下划线开头的文件或目录、`.d.ts` 等声明文件、`.test.*`、`.spec.*` 不参与路由发现
- useFoo.ts、schema.ts 不是页面；普通 useFoo.tsx 仍按页面处理，不猜函数名或默认导出形状。共置 JSX 辅助文件使用 _components 等明确忽略约定

API 树与页面树各自维护目标文件的逻辑祖先链。group 不增加 URL 段，平铺点号与目录形式采用相同层级；如 users._middleware.ts 与 users/_middleware.ts 表示同一作用域，重复时报冲突。保留文件不是路径前缀匹配器，不能把两棵树的 _middleware 合成统一 URL 表。

页面链只执行服务端页面请求；SSR 内部 API 执行所属 API 链与适用应用中间件，不再执行页面链。Node 运行目录独立使用应用级策略和全局中间件，不从这两棵树推导授权。具体职责见 [application.md](application.md)、[http.md](http.md)、[pages.md](pages.md)、[assets.md](assets.md)。

## 唯一发现结果

发现结果包含文件路径、路由种类、方法、规范路径、参数、作用域层级、页面/布局 ID、配置导出与实际公开文件清单。扫描 public 时使用实际 publicDir。

HTTP、WS/SSE 和页面复用 [http.md](http.md) 的路径规则。相同路径形状和具体方法、页面作用域重复、GET/SSE 占用同一 GET 等冲突立即诊断，指出全部来源。不同形状按静态段、参数段、通配段排序，不能依赖磁盘遍历顺序。

方法集合、all 与作用域信息来自同一发现结果。运行时先匹配当前方法的业务处理器，未命中才以 Hono 公开路径匹配判断 404/405 和 Allow；业务 404 不改写，GET/SSE 派生 HEAD，不为方法检查复制路径解析器。

页面可导出 loader、action、meta、cache、shouldRevalidate。SSE 事件类型、endpoint 类型通过业务 TypeScript 引用参与类型推导；不从泛型提取 JSON，也不把 API 路由声明表发给客户端。

生成的页面装配保留 Loader/Action 导出的具体函数类型，支持 [pages.md](pages.md) 的路由参数泛型。运行时按文件路由匹配产生字符串或通配段数组；typed client 继续按目标 endpoint 检查参数。

框架端点按实际启用后的方法与路径参加冲突检查，包括 Node 探针、指标、OAuth 和 visitors 初始化；不禁止整个 /__sark 前缀。应用领域端点在创建业务资源前校验；Node 探针在宿主监听前检查已装配的 API、页面和领域端点，失败沿启动清理释放实例，不另外登记一套路由。运行目录前缀与文件路由按既定优先级处理。

Node 开发分发同时识别已装配的静态框架端点，不要求这些端点位于 apiPrefix/webPrefix 下，也不依赖请求接受 HTML；关闭页面发现时同样可用。Vite 模块和公开构建资源仍由各自的资源处理分支交付。

Node 开发环境将 Sark 包作为外部依赖加载，包括工作区链接的包，使应用与宿主共享请求作用域和生命周期登记；Workers 继续由官方插件在所属运行环境装配，不套用 Node 的外部依赖设置。

OAuth 端点使用 [oauth.md](oauth.md) 的已解析 signInPath/callbackPath，不按提供方 id 固定拼接路径；不执行配置工厂探测端点。默认路径与应用覆盖使用同一套装配和冲突检查。

## 按能力生成装配

官方能力各自提供构建期装配信息：声明名、目标限制、必要依赖、运行时导入、请求处理接入与类型推导规则。tooling/build/capabilities 只汇集这些构建信息，不初始化 SDK。

生成过程只选已发现的能力和页面/连接入口，显式导入对应声明与装配函数。驱动入口持有自己的初始化引用，生成器不执行配置来猜驱动。运行核心没有全量能力注册中心。

装配检查各能力的依赖：认证因素需要 session，CF 的认证流程需要满足 MFA 契约的共享状态，health 需要 Node probes，自动 visitor/user/client 去重需要对应身份来源。数据库先于借用者创建，身份解析先于业务执行；用户无须排列导出顺序。

### 目标支持范围与诊断

支持范围由 Sark 选定的接入负责，不等于上游协议或 SDK 的全部适用环境：

- 仅 Node：server/node、assets/node、db/sqlite、db/postgres、storage/local、storage/s3、health、metrics，以及 Node 文件 sink；在 Workers 中启用这些接入时报目标错误
- 仅 Workers：db/d1、storage/r2 的平台 binding 接入；Node 不接受 D1/R2 binding 声明。通过 Node 的 storage/s3 访问 R2 S3 API 属于 S3 兼容后端，不是 R2 binding
- 两目标共有：HTTP、页面、session、OAuth、visitors、stats 共同契约、TOTP/WebAuthn 与共同认证流程。官方领域 SQL 适配跟随所借数据库，sqlite/postgres 为 Node，d1 为 Workers；auth/state/postgres 为 Node，auth/state/d1 为 Workers
- 平台分别接入：storage/presign 的 Node S3 签名/Workers R2 签名、jobs 的 Node 调度/Workers Scheduled、rateLimit 的 Node 窗口/Workers binding、日志的相应平台输出。完整限制由各专项定义

本次 storage/s3 只交付 Node 接入，不据此宣称 S3 协议或 SDK 天然不能用于 Workers。纯类型导入、纯 schema 导入不算初始化相应驱动。

storage/presign 只能组合到对应目标的对象存储声明：Node 的 storage/s3 使用 AWS SDK v3 预签名并复用所属客户端，Workers 的 storage/r2 使用 AWS S3RequestPresigner 和平台 SHA-256 实现生成预签名；storage/local 不支持预签名。未声明时不生成签名实现或加载签名代码，Workers 的 R2 预签名不引入 storage/s3 运行代码。配置约束见 [storage.md](storage.md)。

静态可识别的官方不支持声明在构建期诊断；工厂返回的 binding、具体选项及映射在创建阶段校验。未知回调内部行为沿正常目标模块检查和初始化错误报告，不为了提前发现文件 sink 而执行工厂、猜函数名或分析任意业务函数体。

## 生成目录

中间生成物固定写入 Vite 项目根目录下的 `.build`，不提供自定义选项。最终部署产物目录仍由 Vite 的 build.outDir 配置。

```text
.build/
├── app.ts                   导出 definition、AppDefinition 与 Api 类型
├── resources-types.ts       选中环境、数据库和存储的类型
├── services-types.ts        选中服务及请求/任务类型
├── types.d.ts               HTTP 与服务端类型注册
├── client.tsx               有页面时的水合/导航入口
├── start.ts                 Node 标准生产接入
└── worker.ts                CF Fetch/Scheduled 接入
```

目标只生成自己需要的宿主入口。没有页面不生成 client.tsx。纯类型文件不产生运行资源，生成只在内容变化时写入。

app.ts 导出同版本内部 createDefinition 产生的 definition。导入本身不连接数据库、不打开日志或执行任务。标准入口和公开 createApp 使用同一个定义。应用测试与自定义宿主传递生成定义，不手写 AssemblyInput。

AppDefinition 描述生成定义，Api 描述 endpoint 的精确类型，server 导出的 AppInstance 描述 createApp 返回实例。启用 session 时，生成声明再导出 RequestAuth。默认客户端注册在 @olivaw/sark/http；client 从 http 复用，不能维护第二份 Register。

配置回调只引用 resources-types 和底层契约，services-types 随后合成。server 的类型注册与 HTTP 注册分别声明资源/服务和 Api，不让 Db 通过 client 注册反向推导自身。

声明的环境类型规则由 [application.md](application.md) 定义。resources-types 引用选中声明并提取工厂输入，按能力展开具名集合，合成环境交集；生成的 definition 保留要求。无工厂时 env 可省，有工厂时 createApp 必须收到满足交集的环境。Node 标准入口传原始 ProcessEnv，Workers 使用所选项目的 Wrangler Env；类型检查必须覆盖真实入口对 createApp 的调用，不以断言消除不兼容。

## 浏览器运行时配置与类型声明

浏览器运行时配置只包含页面路由结构、scope ID、浏览器模块引用、公开 API 基址及必要页面策略；不包含 API Handler、仅供服务端使用的地址、秘密、绝对文件路径和驱动。类型声明单独生成，只引用实际启用的声明；类型信息不编码成运行时 JSON。

静态工程信息由生成器输出；依赖运行期工厂的公开 API 基址、api.credentials 等值，由 SSR 启动载荷交付，见 [rendering.md](rendering.md)。serverUrl、Env 工厂和身份映射回调仍只保留在服务端。

Vite manifest 提供 chunk、CSS 与依赖。SSR 按实际路由和模块依赖收集样式，客户端导航准备目标模块与 CSS。普通 CSS/CSS Modules 沿 Vite 处理。

浏览器导入 Node 内置模块、数据库、服务端配置或协议验证 SDK 时，构建报出导入链。纯 API 生产入口不得解析 React/页面初始化；独立 http 入口不得提前加载 client 的 React 聚合。

page 公开入口只包含同构信号、类型和纯声明构造，Loader/浏览器可安全导入；不从中导入应用 app.ts 或服务初始化。沿上述导入链检查验证该入口，不另建模块扫描系统。

## Node 构建与启动

Node 产物布局：

```text
dist/
├── server.mjs               环境加载与标准 Node 启动
├── server/                  私有服务端模块与动态装配 chunk
├── client/                  有页面时的哈希资源
├── public/                  Vite publicDir 的公开文件
└── manifest.json            有页面时的资源清单
```

start.ts 编译为 server.mjs，先加载 Node 环境，再动态导入应用定义，调用 createApp 完成声明解析与资源创建。Node 宿主复用本次 runtime 解析结果，将有效 port/hostname 传给 Hono 的监听器并安装信号，不重复执行 runtime 工厂。监听字段按 [application.md](application.md) 的优先级处理；Vite 开发监听仍由 Vite 的 server 配置管理。服务端打包保留这条求值边界，不把配置模块提前内联求值；否则对象配置读取环境的时机会错误。server/ 中的私有 chunk 不进入浏览器静态文件清单。

运行产物不依赖 Vite。外置运行依赖与原生驱动必须随部署安装，不能把未打包误当成不需要。

`sark generate`、`sark dev`、`sark build` 在应用根读取同一份 Vite 配置。dev/build 复用发现与生成，不维护第二个扫描器。generate 不监听端口；dev 挂载 Vite；build 完成浏览器与服务器构建；`sark start [entry]` 只执行产物，默认 dist/server.mjs，不扫描源码、不重新生成。无参数或 help 显示帮助，未知命令非零退出。

自定义 outDir 时 start 传对应入口；直接 node 执行同一文件等价。配置、生成、构建或启动失败返回非零码。正常终止按宿主预算退出。

## Workers 构建与启动

CF 目标复用 @cloudflare/vite-plugin，在 workerd 内开发和预览。配置使用同一份 Wrangler，main 指向生成的 .build/worker.ts，插件使用 ssr 环境；Sark 在所需入口解析前完成生成。

```ts
import { cloudflare } from '@cloudflare/vite-plugin'

plugins: [react(), sark({ target: 'cloudflare' }), cloudflare({ viteEnvironment: { name: 'ssr' } })]
```

Wrangler 是 compatibility_date、bindings、secrets、triggers.crons 的唯一来源。构建环境选择采用官方插件的 CLOUDFLARE_ENV 规则；检查使用所选环境的有效配置，不只读取顶层原文。

Worker 输出目录及生成的 wrangler.json 以官方插件结果为准，不生成供 node 执行的 server.mjs。浏览器公开文件通过插件接入平台静态资源服务，不在 Worker 读取本地 dist 目录。部署与预览使用构建生成的 Wrangler 配置，sark start 仅用于 Node。

Scheduled 映射逐项核对有效 crons：每个配置触发有处理任务，每个 onCron 有实际触发。相同 cron 可派发多个具名任务；未知运行事件报告配置错误。不改写 CF 星期和 UTC 语义。

## 开发替换与类型检查

插件按前述配置时序发现和生成，Node configureServer 接请求及升级；CF 使用官方插件的 Worker 环境。配置依赖由 Vite 模块图跟踪，前端更新不重建数据库/任务。

服务端替换遵守 [application.md](application.md) 的排空与资源交接。生成器不自行恢复未结束的旧任务。开发时关闭页面实例缓存，生产按声明启用；两者的路径、输入输出、请求检查与错误语义保持一致。

统一类型检查覆盖手写源码、真实生成装配、类型注册、Node 启动和 Worker 入口。类型夹具继承相同编译目标与模块条件，不另设参数让它得到不同结论。生成的注册声明显式导入被扩展的 HTTP 模块，使仅使用页面入口的代码也能取得默认 API 类型；内部类型直接引用本地 Register。

应用在类型检查前先执行 generate，tsconfig 的 include 除手写源码外，还须显式包含 `.build/**/*.ts` 和 `.build/**/*.tsx`，覆盖注册声明、应用装配及目标宿主入口。不能只检查业务文件或仅让 Vite 转译；生成目录不作为类型排除项。

框架源码和测试使用相对导入，不设置包路径别名。tests/unit 验证独立逻辑，tests/contract 验证内存协议和生命周期，tests/contract/types 分别编译独立类型程序，tests/integration 验证真实宿主、构建产物及工程流程。需要固定维护的输入放 tests/fixtures；可写执行工程及产物放 .build，结束后清理。

普通 typecheck 不依赖 dist，覆盖框架源码及引用源码的全部测试，包括集成测试。只有直接导入构建包的 `tests/integration/package*.test.ts` 由独立程序检查；`tests/tsconfig.json` 继承根编译条件，仅指定这组文件，不修改编译目标或模块条件。构建后执行 `pnpm typecheck --project tests`，按真实 exports 检查产物声明。测试目录保持按验证对象分组，不为编译配置另加目录层级。

临时类型程序显式包含实际生成物，分别编译以隔离类型注册。完整 test 命令构建一次、检查包消费程序，再执行全部测试；测试目录通过脚本的 `--dir` 参数指定。
