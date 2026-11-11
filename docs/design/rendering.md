# 渲染、水合与 API 传输

## 一体运行的完整链路

Node 与 Workers 都采用同构 Loader/Action。SSR 通过框架绑定 client 在当前应用内分发到 API，不经过网络回环；浏览器导航通过 HTTP 调用同一 API。

SSR 依次执行：

1. 建立请求作用域、解析身份，匹配页面与布局
2. 并行执行本次计划中的 Loader，收集作用域结果和 meta
3. 汇总适用的状态、Cookie、私有标记与页面缓存头
4. 调用 React 19 renderToReadableStream，等待 shell 就绪
5. 提交响应头，再流式交付 shell/Suspense 内容及启动信息

shell 失败时仍未提交头，可以交付独立错误文档。提交后不能修改状态或 Set-Cookie；组件与 Suspense 的后续异常沿 React 恢复机制。等待 Loader 和 shell 是明确成本，不承诺零等待。

内部 API 产生的 Set-Cookie、private/no-store 会限制最终 HTML 是否可被公开缓存。不能缓存一份带私人数据的启动载荷，再期望只换响应头解决隔离。

## 页面/API 分开部署

页面文件发现仍启用页面运行时，需要改变传输时从 page 导入 definePage：

```ts
import { definePage } from '@olivaw/sark/page'

type Env = NodeJS.ProcessEnv

export const page = definePage((env: Env) => ({
  api: { serverUrl: env.INTERNAL_API_URL, browserUrl: '/api' },
  identity: async ({ client, signal }) => {
    const user = await client.get('/me', { init: { signal } })
    return { user }
  },
}))
```

这是 Node 环境工厂示例；Workers 使用 Wrangler Env，环境来源与校验见 [application.md](application.md)。api 为可选的远端模式，选用时 serverUrl 必须是完整受信 API 基址，browserUrl 为浏览器可访问基址，缺省采用工程 apiPrefix。两种 API 基址均不含 query、fragment 或 URL 内凭据，在配置入口校验；serverUrl 只接受绝对 HTTP(S)，browserUrl 另可使用相对路径。api 另接受 `credentials?: RequestCredentials`，传给浏览器绑定客户端；默认值与单次调用覆盖沿 [http.md](http.md)。

浏览器从生成入口取得默认 API 前缀。服务端解析 page 声明后，仅将与默认值不同的公开 API 基址和 credentials 写入启动载荷。声明解析时机遵循 [configuration.md](configuration.md)，identity 等请求回调按请求执行。

identity 是可选的 SSR 映射回调，签名为 `({ client, signal }) => IdentitySnapshot | Promise<IdentitySnapshot>`；同应用内部传输和远端 api 模式都可以使用，不要求先声明 api。

声明 api 时必须提供 serverUrl 属性，可直接赋可能缺失的环境值；入口拒绝缺失或无效地址，不能据此回落到本地 API。不声明 api 时使用本应用内部调用；不在本地返回 404 时尝试远端。远端模式和本地模式只改变传输，不改变 Loader、Action、错误和类型调用。

未配置 identity 时，单体默认将已验证身份的 sub 和可选 roles 映射到 user，无身份则 user=null；不自动生成 displayName。分离模式默认匿名展示快照，API 仍自己认证。应用可通过 identity 或 Loader 数据提供展示名；框架不猜 /me 的名称与响应字段，页面服务不必持有后端 DB/签名密钥。

API 类型通过工程 apiTypes 或独立类型引用交付。浏览器运行时配置只保留公开 API 基址 browserUrl 及 credentials 等必要传输策略；serverUrl、Env、回调和秘密不发送到浏览器。独立 HTTP 消费者直接使用 client 入口，无须 React。

## 远端请求与 Cookie 传递

框架绑定的 API client 只向显式受信目标传递必要 Cookie/Bearer、请求 ID 和取消信号；普通外部 createClient 不自动继承当前请求秘密。请求按 API 基址构造，不接受浏览器指定任意服务器地址。应用显式使用 requestRaw 调用基址外的绝对 URL 时走普通 fetch，不自动继承入站凭据。

服务端不使用 credentials 枚举模拟浏览器 Cookie jar；内部调用保留当前请求上下文，远端 SSR 按受信目标规则显式转发凭据。浏览器的 include 不扩展 SSR 可转发秘密的目标。

远端业务请求传递取消信号，框架不设置默认操作期限，以保留长查询和持续流语义。有限操作可由应用通过 init.signal 指定期限，并保留所属请求的取消：

```ts
await client.get('/report', {
  init: { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
})
```

上例中的 signal 来自 Loader/Action 参数；期限同样覆盖响应正文读取，不是整个 SSR 的总期限。

远端 fetch 使用手动重定向，客户端按既定 HTTP 响应及错误规则处理，不向重定向目标继续发送秘密，也不把 API 重定向直接变成页面导航。网络故障作为调用失败，由页面边界处理。

后端仍执行外部请求的认证、来源、限流与授权，不信任某个头声称已经通过内部认证。公开 origin 的还原由部署入口完成；需要浏览器来源的请求保留真实 Origin，不能用内部 DNS 伪造浏览器来源来绕过 CSRF。

Set-Cookie 按独立字段逐条接到外层响应，保留专用属性与删除值；提交后收到需写 Cookie 的结果报告时序错误。Domain/Path/Secure 必须对应公开应用，框架不把内部地址域自动写成 Cookie 域。

优先公开同源、按路径转发页面/API，减少跨站凭据成本。真正跨站时明确 credentials、CORS、SameSite 与 Cookie 作用域，配置一个 URL 不会自动共享浏览器会话。

## 启动载荷与安全序列化

```ts
interface BootstrapPayload {
  config?: {
    api?: { browserUrl?: string; credentials?: RequestCredentials }
    policy?: { caseSensitive?: boolean; trailingSlash?: 'never' | 'always' | 'ignore' }
    visitorPath?: string
  }
  request: {
    identity?: IdentitySnapshot
    scopes: Record<string, ScopeSnapshot>
  }
}

type ScopeSnapshot =
  | { status: 'success'; data?: unknown }
  | { status: 'error'; error: PageError }
  | { status: 'idle' }
```

config 仅携带浏览器需要的运行时覆盖项。request 只包含当前页需要的作用域结果与公开身份字段，匿名身份省略。框架从身份映射结果选取 sub、roles 和 displayName。应用应在 Loader 中选择当前页面需要且当前用户有权读取的数据，返回值会进入 HTML。成功 undefined 用 success 且不带 data 表达。

SSR 的 Loader 和 meta 使用请求入口已解析的可信公开 origin，并保留本次 path/query。浏览器从实际文档地址取得 URL 和路由参数，包含服务器无法取得的 hash。两端共享参数解析、静态段与尾斜线规则。页面跳转仅接受相对地址或 HTTP(S) URL，业务可进一步限制目的地。

载荷只接受 JSON 可序列化值。Date/Map 等对象不能在 SSR 与浏览器首轮变成不同形态；需要它们时由应用先转换为一致数据。嵌入 HTML 的 JSON 转义 <、U+2028、U+2029，不能用原始 JSON 字符串突破 script 边界。

## 水合与首屏资源

整份 document 水合，单应用单根：hydrateRoot(document, App)。_root 可自定义，默认根组合 Head/Outlet/Scripts，不需要容器 ID。

SSR 按实际 root、布局、页面及其组件依赖收集 CSS，由 Head 输出去重、保序的 stylesheet 标签。水合时复用首屏标签，后续导航随 Vite 动态导入加载目标模块的 CSS。已加载的模块样式表在当前文档内保留，切换路由后仍按 CSS 层叠规则生效。全站资源映射保留在构建和服务端交付链路。

Scripts 输出 `id="__PAGE_CONTEXT__"` 的 JSON 载荷元素，React 注入一次浏览器入口。客户端读取载荷并准备首屏模块后水合。载荷或模块准备失败时保留静态 SSR 输出，进入 React 后按 React 恢复行为处理。

Node 与 Workers 分别解析适用 React 服务端导出入口和目标条件，普通 CSS/CSS Modules 沿 Vite，不建设样式框架或 RSC 运行时。

## 客户端导航

匹配目标 → 计算重新加载计划 → 准备模块与 CSS → 执行所需 Loader → 当前导航提交视图、错误、meta、历史、焦点和滚动。

没有额外页面数据端点；取数走既有 API。CSS 加载失败不算导航准备成功。预取是优化，缺预取不阻止正常导航。

新导航或身份变化后，旧操作不能再提交页面结果；取消不会回滚已经提交的写入。retry 只重新加载失败作用域并重置对应错误边界，reload 强制重新加载当前匹配。详细公开 API 见 [pages.md](pages.md)。

## 开发、生产与缓存

Node 开发使用 Vite server 和 Sark 中间件/升级桥接；生产使用 Node 宿主。CF 开发与预览使用官方 Vite 插件的 workerd，生产使用对应 Worker 产物。两者共享路由、输入输出和页面规则。

前端 HMR 不重建服务资源；服务端替换先排空/释放再创建，规则由 [application.md](application.md) 维护。

不声明 pageCache 时仍正常流式 SSR，不进行缓存填充、正文缓冲或 LRU 初始化。页面 cache 元数据仍可生成公共响应策略；有响应头不表示 CDN 已自动缓存。启用实例存储后的并发与正文缓冲上限见 [page-cache.md](page-cache.md)。

实例缓存保存未压缩 HTML。命中与未命中都执行本次请求的 CORS 交付，重建其响应头，并在 Node 的唯一交付点按有效策略压缩；Vary 合并内容维度与本次交付维度，不重放首个请求的来源或编码头。具体资格与匹配规则由 page-cache.md 维护。

## 验证

Node/workerd 分别覆盖 API → Loader → SSR → 样式/载荷 → 水合 → 导航/Action，以及 shell 回退、响应头提交前的 Cookie 写入时机和取消。分离部署另验类型交付、受信目标、凭据/Cookie 传递与匿名展示默认值；不通过前端测试成功推断远程认证已正确。
