# 页面、交互与导航

## 文件与导出

页面目录默认 app/，URL 语法沿 [http.md](http.md)：index、[id]、[...slug]、(group) 和平铺点号。页面匹配使用与 HTTP 相同的静态段、参数段、通配段优先级，不按目录枚举顺序。

普通 `.tsx/.jsx` 默认导出页面组件；_layout 是作用域布局，_error 是错误展示，_root 是全应用可选根文档，均使用对应 .tsx/.jsx 文件；_middleware.ts/.js 是服务端作用域中间件。根文档缺省使用 DefaultRoot。

保留文件先按职责识别，其余下划线开头的文件/目录、声明文件、`.test.*`、`.spec.*` 不生成页面。useFoo.ts 不是页面，useFoo.tsx 仍是普通页面，共置辅助组件使用 _components 等忽略约定；完整发现规则见 [build.md](build.md)。页面树按匹配文件的逻辑祖先链组合服务端中间件，不作用于 API 树或运行目录，也不在浏览器本地执行。

页面可导出 loader、action、meta、cache、shouldRevalidate；布局可导出 loader、meta、cache、shouldRevalidate；根文档只组合 Head/Outlet/Scripts，不带数据钩子。相同作用域重复声明报构建错误。

## 同构 Loader

Loader 在 SSR 与浏览器导航执行，只通过 typed client 访问 API，不取得 DB、服务端 visitor 或认证服务。

例如 app/posts/[id].tsx 的 Loader：

```ts
import { notFound } from '@olivaw/sark/page'
import type { LoaderArgs } from '@olivaw/sark/page'

export async function loader({ client, params, signal }: LoaderArgs<{ id: string }>) {
  const post = await client.get('/posts/:id', { params, init: { signal } })
  if (!post) throw notFound()
  return { post }
}
```

上下文与身份快照类型为：

```ts
interface LoaderArgs<Params = Record<string, string | string[]>> {
  client: Client
  params: Params
  url: URL
  signal: AbortSignal
  identity: IdentitySnapshot
}

interface IdentitySnapshot {
  user: { sub: string; roles?: string[]; displayName?: string } | null
}
```

Params 表达文件路由的参数形状：单段 [id] 为 `{ id: string }`，通配 [...slug] 为 `{ slug: string[] }`。省略泛型时使用通用 Record。需要调用要求具体参数的 API 时，Loader 与 Action 显式声明对应形状，并按目标 API 的参数名组装请求。

泛型须与文件路由一致，只表达匹配器产生的参数。实际值沿路由匹配规则产生，API 输入仍按自身 schema 校验。

Client 使用本工程或显式远端 Api 类型。SSR 一体运行走内部调用；浏览器导航走网络；分离部署的 SSR 走明确配置的远端。协议、错误和取消沿用同一客户端。

identity 是展示快照，不含凭据/会话，不替代服务端 API 授权。单体默认只映射已验证身份的 sub 和可选 roles，不生成 displayName；应用需要展示名时通过显式页面 identity 回调或 Loader 数据提供。identity 回调可用于单体和分离传输，见 [rendering.md](rendering.md)。应用需要服务端独占逻辑时写 API。

Loader 用于取数，可能因导航、恢复重新执行，也可能被页面缓存命中跳过。执行次数不是阅读计数、计费或业务写入次数；这些操作由应用在明确业务事件中调用，框架不因缓存命中补造事件。

组件通过 useClient() 取得当前页面绑定客户端。它使用实际 apiPrefix 和请求上下文，不是进程级单例。

页面与布局接收 { data, params, url }，布局子级由 Outlet 渲染。data 是该作用域本次选定的结果；参数变化后是否复用旧结果，由下文的重新加载规则决定。

## Action 与结果

```ts
export async function action({ client, formData }: ActionArgs) {
  const created = await client.post('/posts', { form: formData })
  return { id: created.id }
}

interface ActionArgs<Params = Record<string, string | string[]>> {
  client: Client
  formData: FormData
  params: Params
  signal: AbortSignal
}

interface ActionResult<T> {
  data: T | undefined
  error: PageError | undefined
  revalidateError: PageError | undefined
  pending: boolean
  submit(formData: FormData): void
}
```

ActionArgs 使用与 LoaderArgs 相同的路由参数泛型；动态路由可声明 `ActionArgs<{ id: string }>`。

组件用 useAction(action) 得到结果。提交失败写 error；写入成功但随后的重新加载失败，保留 data，另写 revalidateError。取消不等于服务端回滚，不能把后续取数失败说成原写入失败。

Action 成功后默认重新执行当前页面与布局的 Loader。普通 client.post 等 HTTP 调用不会自动触发页面工作流。Action 属于同构页面逻辑，不提供绕过 API 的 Server Function。

## 数据重新加载与结果复用

数据重新加载通过重新执行 Loader 完成。shouldRevalidate(args) 返回 boolean，参数为 reason（navigate/action/reload）、current/next 的 params 与 URL，以及 defaultShouldRevalidate。

默认参数或 query 变化重新加载，Action 成功重新加载，同路径导航复用；首次、新匹配、无已有结果的作用域必须执行。reload 强制重新加载，不被 shouldRevalidate 阻止。身份变化不自动取数，由应用 reload 或导航。

作用域由声明 ID 标识，不随 URL 参数变化。浏览器只保存当前已提交视图的作用域结果，不建立多 URL 数据缓存。已有结果时，应用可以覆盖默认的重新加载决定；返回 false 表示应用认为旧结果对新目标仍适用。

跳过执行会保留已有数据或错误，提交后组件同时收到目标 params/URL 和被选中的结果，meta 也按它们计算。框架不为应用错误的依赖判断重新执行 Loader。

保存的执行结果只有 success/error；skipped 属于执行计划，idle 属于尚未执行的启动快照。成功 undefined 是有效结果，清除旧数据与旧错误，不能与未执行合并。

## 页面信号与错误

`redirect(url)`、`notFound()` 从 `@olivaw/sark/page` 导出，client 入口复用导出，作为 Error 在 Loader/Action/页面恢复边界抛出与处理。page 只包含同构信号、类型和 definePage 纯声明构造，浏览器可安全导入；应用 app.ts 中的秘密配置不是这个公开入口。HTTP API 不产生页面信号，普通 401/404 不自动转成页面行为。

```ts
interface PageError {
  status?: number
  message: string
  data?: unknown
}

interface ErrorProps {
  error: PageError
  retry(): void
}
```

Loader 异常选择最近作用域的 _error，保留有效外层结果。浏览器组件异常交给相应 React 错误边界。路由未匹配进入根错误展示，不执行布局 Loader。

retry 只重新加载失败作用域，并重置对应浏览器边界；只有组件错误时也可重试渲染，不重新执行所有成功作用域。新成功结果清除旧错误。

SSR shell 失败交付独立完整错误文档，最终回退不依赖已失败的应用根。响应提交后的异常沿 React 流恢复机制处理，不再改状态/Cookie。生产 5xx 遮蔽内部详情；默认错误页保留适用状态。

## 导航与提交

Link 默认预载目标模块与样式，prefetch=none 关闭。它沿原生链接语义处理外链、下载、新窗口和修饰键，不拦截不属于应用的行为。

useNavigate 返回 navigate(to, options?)，选项包括 replace、preventScrollReset、state；返回 Promise<{ committed: boolean }>。

committed=true 表示当前导航已提交页面、错误、meta 和历史，包括目标错误边界；重定向以最终提交为准。守卫拒绝、被新导航替代或硬导航不产生应用内提交时为 false。它不表示取数或此前业务写入成功。

每次新导航取消旧导航，只有当前导航可以提交结果。旧请求即使随后成功，也不能覆盖新视图、错误、元数据、历史或身份。目标 params/query 参与重新加载计划；提交阶段处理历史、滚动与焦点。

useNavigation() 返回 state: idle/loading/submitting；Action 绑定函数而非目标 URL，因此不伪造一个提交地址。`reload(): Promise<void>` 表示刷新流程结束，失败通过页面状态表达，不等于业务取数保证成功。

## 离开守卫

useBlocker(handler, enabled=true) 随组件注册/卸载。handler 接收 currentUrl、nextUrl、signal，可返回 boolean/void 或 Promise；false 阻止，其他允许。多个守卫按注册顺序判断，异常按取消处理并记录。

过期守卫结果不能提交。启用时连接浏览器原生退出确认，原生确认不能等待异步业务；纯数据 reload 不触发离开守卫。

## 身份快照更新

setIdentity(snapshot) 只在浏览器更新当前展示快照，SSR 调用无效。它禁止旧身份下尚未完成的导航提交结果，后续 Loader 读取新快照；不自动重新加载或重定向。

应用在登录、退出或自己的身份查询完成后映射快照，再明确 reload/导航。框架不读取业务响应字段来猜登录结果，也不因 Cookie 改变而自动推断。

```ts
await client.post('/auth/signin', { json: credentials })
setIdentity({ user: { sub: user.id, roles: user.roles } })
const { committed } = await navigate('/dashboard')
if (committed) closeDialog()
```

credentials、user、closeDialog 及该登录 API 来自应用。本例表达调用顺序，不代表框架统一定义登录路径或响应。

## 元数据与组件

meta({ data, params, url }) 返回 title、description、canonical、robots、openGraph、twitter、links、scripts。布局向页面逐字段覆盖，页面优先。

links/scripts 按用于识别重复项的属性合并：canonical 等单值关系按 rel 覆盖；alternate 保留语言/type/media 差异；stylesheet/preload/modulepreload 保留不同 URL 和用途属性；外链脚本按 src 去重，没有可用去重键的内联脚本按顺序保留。不能只按 rel 删除多个样式表。

显式 key 标识同一项，子级替换父级并保留原位置；没有 key 的外链脚本按 src 采用同样覆盖规则。manifest 与 canonical 均为单值关系，不因 href 不同而保留多个。

Head 自动输出 meta 与框架样式，children 可放应用 head 内容。Outlet 渲染子作用域。Scripts 输出经过安全序列化的启动载荷，入口脚本由渲染器注入一次；应用不传内部快照。

Link 继承除 href 外的 AnchorHTMLAttributes，以 to 指定目标，支持 prefetch: none/module 与 replace。Head 接受 ReactNode，Outlet/Scripts 无必填 props。根文档负责组合这些组件，不要求固定容器 ID。

Link 点击与预载使用锚点已按文档 base URL 解析的地址；编程式 navigate 的相对地址仍按当前已提交视图解析。

## 页面缓存声明

页面/布局可导出 `cache: PageCacheConfig | false`，对象字段为 ttl、staleWhileRevalidate（均为秒）、tags、vary。false 关闭该处继承，子级可显式重新声明。布局继承、页面覆盖与实例缓存的启用规则由 [page-cache.md](page-cache.md) 唯一维护。

页面执行、错误恢复和导航不依赖 pageCache 存储。缓存优化不能改变应用显式 shouldRevalidate、身份快照或授权职责。

## 验证

真实链路覆盖布局/页面并行 Loader、首屏快照、导航与 Action、成功 undefined、错误复用/恢复、shouldRevalidate 覆盖默认决定、身份变化、过期导航结果不得提交、守卫及元数据合并。React 错误恢复在实际渲染边界验证，不手动调用组件方法冒充浏览器恢复。

类型验证覆盖 LoaderArgs/ActionArgs 的具体参数形状、默认通用形状和生成装配：单段字符串可传给对应 API，通配数组不能误传给字符串参数，缺少必填参数仍报错。实际匹配分别验证单段与通配值，不以手工构造上下文代替路由验证。
