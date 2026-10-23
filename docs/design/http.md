# HTTP 接口与客户端

## 文件路由与匹配

apiDir 默认 api，apiPrefix 默认 /api。目录和平铺点号等价；index 省去末段，(group) 不进入 URL，[id] 是单段参数，[...slug] 是通配参数，[.] 表示字面点号。

例如 users.[id].get.ts 对应 /api/users/:id，site[.]webmanifest.get.ts 对应 /api/site.webmanifest。

方法后缀为 get、query、post、put、patch、delete、options、all。HEAD 从 GET 派生并剥离正文；all 是同路径下未声明具体方法时的默认处理器。ws、sse 分别声明连接与事件流，沿同一套路径语法。

对当前方法有效的候选，按静态段、单段参数、通配段的顺序从左到右优先匹配；同形状内具体方法优先于 all。更具体路径的 all 优先于较泛参数路径的具体方法。其他方法的路由不阻挡当前请求。生成器按此排序交给 Hono，不再实现另一套 HTTP 路由器。

同形状、同具体方法重复时报冲突，参数名字不同不构成两个独立形状。GET 与 SSE 都占用 GET，不能按 Accept 偷换处理器。

API 树只发现带上述方法、ws 或 sse 后缀的 `.ts/.js/.tsx/.jsx` 模块，无后缀辅助文件不生成路由。保留的 _middleware.ts/.js 先按作用域处理；其余下划线开头的文件/目录、声明文件、`.test.*`、`.spec.*` 忽略。完整分类与祖先链规则见 [build.md](build.md)。

### 方法不匹配

先按当前方法和适用 all 匹配业务处理器，只有未命中时才判断其他方法：

- 没有路径匹配返回 404；路径支持其他方法，但当前方法既无具体处理器，也无适用 all 时，返回 405 与 Allow
- Allow 使用实际支持的大写方法，GET/SSE 隐含 HEAD，不把 ALL 写入其中
- 只有 all，或 GET 与 all 并存时，其他方法由 all 处理，不产生 405
- 已命中处理器主动返回的业务 404 保持不变，不在响应后按状态改写为 405
- 非预检 OPTIONS 优先显式 options，再 all，均无时按路径返回 404/405；CORS 预检按其独立规则处理

例如 GET /items/:id 与 POST /items/new 并存，GET /items/new 仍匹配 GET 参数路由。方法集合来自唯一发现结果，动态路径匹配复用 Hono 公开能力，不用字面路径 Map 代替参数匹配。装配区分业务 all 与全局中间件；Hono methodNotAllowed 无法区分 use/all，不直接作为完整实现。[Hono 方法检查源码](https://github.com/honojs/hono/blob/v4.13.13/src/middleware/method-not-allowed/index.ts)

## URL 规范化

trailingSlash 默认 never：GET/HEAD 把 /a/ 以 308 转到 /a。always 相反，ignore 不重定向且保留两种 URL。非 GET/HEAD 两种形式直接匹配同一处理器，不因规范化重放正文。根路径与静态文件不参与。

caseSensitive 默认 false，静态段大小写按共同规范处理；GET/HEAD 可 308，其他方法直接匹配，动态参数值不改写。WS 不重定向，仍按相同路径规则匹配。

匹配使用规范化后的路径，不改动原始 Request.url。服务端、作用域、页面导航、链接和缓存使用相同规则；ignore 时保留的不同 URL 快照不合并为同一个缓存产物。

## 声明与输入

```ts
import { route, z } from '@olivaw/sark/server'

export default route({ bodyLimit: 512 * 1024 })
  .validate({ params: z.object({ id: z.string() }), json: BodySchema })
  .handler(async (ctx, input) => {
    return ctx.json(await updateUser(ctx.var.db, input.params.id, input.json))
  })
```

route(options?) 接受 middleware、bodyLimit、cors、csrf 及已启用能力的局部策略。validate 可省，省略时 input 为 {}。handler 必需，接收 Hono Context 与校验后的 input。

输入有六类字段：

- json：application/json 及兼容 +json 正文
- form：urlencoded 或 multipart 正文
- text：文本正文，保留原字符串
- query：URL 查询，同名多值保留为数组
- params：文件路径参数
- headers：请求头，名字小写

json/form/text 三种正文字段互斥，同时声明多个时，在资源创建前报错。GET/HEAD 不声明或发送正文；POST、PUT、PATCH、DELETE、OPTIONS、QUERY 可以声明。all 声明不得让 GET/HEAD 依赖正文，不能绕过方法限制。

正文按 Content-Type 解析，媒体类型不适用返回 415，语法错误或 schema 校验失败返回 400。缺省正文与空值按 schema 分开处理。正文上限同时覆盖流实际读取，不能只信 Content-Length。

form 同时接收 multipart/form-data 与 application/x-www-form-urlencoded；同名多值收集为数组、单值保留标量、文件保留 File。数字/布尔等文本转换由 schema 明确执行，不发明嵌套表单编码。

## 成功输出与 Accept

普通业务值采用 JSON 表示，状态 200；普通字符串也编码成 JSON 字符串。应用需要纯文本、HTML、其他状态或流时返回明确的 Hono typed Response 或原生 Response，框架保留其表示与状态，同时执行共同响应策略。

自动 JSON 使用 negotiator 的媒体匹配，候选只有 application/json：

- 无 Accept，或 `application/json`、`application/*`、`*/*` 的有效权重大于零：返回 JSON
- `text/html, */*;q=0.8`：通配接受 JSON，正常返回
- 只有 `text/html`：返回 406
- `application/json;q=0, */*;q=1`：具体排除优先，返回 406

不按字符串猜另一种表示，也不无视明确请求。自动 JSON 和 406 合并 Vary: Accept；显式 Response 的表示选择由应用承担，不再自动协商。negotiator 只处理服务端头匹配，不绑定 Node IncomingMessage，不进入浏览器产物。[RFC 9110 协商](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.4.1)

undefined 返回 204，不做 JSON 协商。204/205 无正文；HEAD 保留适用状态与头并剥离正文。406 不回滚此前业务写入，客户端不因此重试写操作。

## HTTP 错误

```ts
class HttpError extends Error {
  constructor(
    status: number,
    message?: string,
    options?: { code?: string; details?: unknown; headers?: HeadersInit },
  )
  readonly status: number
  readonly code: string
  readonly details?: unknown
  readonly headers: Headers
  readonly body?: unknown
}
```

默认 code 为 http_error，headers 为独立 Headers。服务端通过该构造函数创建时 body 为 undefined，不另存一份响应体；序列化时由 code/message/details 生成相应状态、适用响应头和以下错误响应体：

```ts
interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}
```

code 用于程序识别，message 用于展示。未知异常记录实际错误，生产返回 500 的通用信息，不带内部堆栈或敏感 details。401 在适用认证方案下提供 WWW-Authenticate。错误响应体不再进行 Accept 协商。

客户端收到非 2xx 响应时抛出同一 HttpError，保存实际状态、响应头与已解码 body。响应体不符合框架错误格式时，code 使用 http_error，仍保留网关等外部服务的正文。网络失败和取消保留传输错误。requestRaw 不按状态抛错。

HTTP 错误不自动变成页面 redirect/notFound；应用决定后续交互。

## 客户端与类型来源

```ts
import { createClient } from '@olivaw/sark/http'

const client = createClient()
const other = createClient<OtherApi>({ baseUrl: 'https://api.example.com/v1/api' })
```

页面工程使用生成的 Register.api；独立使用或访问另一服务显式传 Api。client 页面入口聚合同一实现。baseUrl 默认 /api，框架绑定的 Loader/useClient 使用实际 apiPrefix 或页面远端配置。

客户端构造入口按 [configuration.md](configuration.md) 解析实例默认值，发送逻辑只应用单次调用覆盖。

API 相对路径类型按完整 apiPrefix 及路径边界从 endpoint 路径派生。运行时将调用路径附加到 baseUrl，不按后缀或重复业务段裁剪调用路径。

```ts
interface ClientOptions<A> {
  baseUrl?: string
  credentials?: RequestCredentials
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  fetch?: (request: Request) => Promise<Response>
}

type TypedInit = Omit<RequestInit, 'method' | 'body' | 'headers'>
```

类型化调用统一为 `client.verb(path, options?)`。options 包含 endpoint 声明的 query、params、一个正文字段，以及 `headers?: HeadersInit`、`init?: TypedInit`。先取得实例配置的请求头，再由调用参数覆盖同名值；headers schema 仍由服务端校验，类型不要求每次重复提供实例已配置的头。

实例构造时将省略的 credentials 解析为 Fetch 的 same-origin 默认值，不自动 include；单次调用的 init.credentials 覆盖已解析实例值。页面绑定客户端沿同一规则，SSE 建连/重连与 requestRaw 也继承实例值。服务端 Fetch 不由 credentials 枚举产生 Cookie jar；SSR 的凭据传递见 [rendering.md](rendering.md)。

客户端没有运行时路由声明表。方法与路径在类型层先选 endpoint，再派生输入与成功输出：

- 只允许声明的正文字段，另两种字段用 never 排除；通过变量传参时同样不能同时提供多个正文字段
- 必填 params、必填 query、必填正文存在时 options 必填；否则整个 options 可省
- 正文字段的可选性取决于整个 schema 是否可选，不等于对象内部字段都可选
- GET/HEAD 不开放正文，类型化调用只允许已声明的方法与路径组合
- 返回类型表达实际解码值：JSON Date 是字符串，typed text 是 string，204/205 是 undefined
- 未知状态/表示的原生 Response 返回 unknown，不能误过滤成 never；需要头、状态或流时用 requestRaw

```ts
type JsonBody<J> = { json: J; form?: never; text?: never }
type FormBody<F> = { form: F | FormData | URLSearchParams; json?: never; text?: never }
type TextBody<T> = { text: T; json?: never; form?: never }
```

所有类型化方法均返回 Promise：head 解析为包含响应元信息的 Response，其他方法解析为对应成功输出。`requestRaw(method, path, options?)` 保留原生 RequestInit 和 Response，不使用类型化正文编码及非 2xx 转异常规则。

## 请求编码与解码

json 使用 JSON 编码，Content-Type 默认 application/json，允许显式指定兼容的 JSON 媒体类型。text 默认 text/plain，可明确指定其他文本媒体类型；与已选编码冲突的 Content-Type 报调用参数错误。类型化调用默认 Accept: application/json，保留调用方显式覆盖。

form 为含 Blob/File 的对象时编码 multipart，纯文本对象编码 urlencoded，数组按重复字段。FormData 与 URLSearchParams 保留容器语义，不静态检查内部字段。multipart 删除外部 Content-Type，由 Fetch 产生 boundary；不手写不匹配的边界。

运行时同样拒绝同时提供多个正文字段，不静默选择其中一个。init 不开放 method/body/headers；需要直接控制原始正文时使用 requestRaw。

解码先判断 204/205，再按 Content-Type：JSON/+json 保留数字、布尔、字符串、null 等原值；text/* 返回字符串；其他返回 ArrayBuffer。JSON 解析失败是解码错误，不伪装成合法空结果。

## 中间件与 Cookie

`cors(options)`、`csrf(options?)`、`compress(options?)` 从 middleware 导入，返回 Hono MiddlewareHandler；`rateLimit(options): MiddlewareHandler` 从 middleware/rate-limit 导入，完整选项与独立声明的区别见 [rate-limit.md](rate-limit.md)。CORS 选项沿上游，必须明确 origin。CSRF 与压缩接入遵循下列约定。

CORS 负责跨域响应，CSRF 负责适用的浏览器请求防护，授权由应用执行。Bearer 豁免依据是已通过 Bearer 认证，不是头存在。OAuth 回调的局部协议例外不扩展到业务表单。

### HTTP CSRF

csrf 默认开启，true 或省略使用默认规则，false 关闭对应有效策略；对象配置及显式 csrf 中间件接受 `origins?: string[]`：

- GET/HEAD/OPTIONS 放行；其他方法只对 application/x-www-form-urlencoded、multipart/form-data、text/plain 检查。缺 Content-Type 按 text/plain；JSON 不经过同一表单来源拒绝规则
- 复用 Hono CSRF：Sec-Fetch-Site=same-origin，或 Origin 通过允许规则，任一成立即通过；需要检查但两者都缺失时拒绝，不回退 Referer
- 允许来源为当前外部 origin 加 origins 的精确匹配项；origins 不支持通配符或普通 `null` 允许值。外部 origin 由宿主按可信代理/平台信息还原，不直接使用代理内部 Request.url
- 拒绝为 403，错误码 csrf_forbidden；仅转换来源检查自身的拒绝，业务 403 保留原有业务错误码
- 已通过 Bearer 认证及受信 SSR 内部调用使用既定豁免。非浏览器 JSON API 可正常调用；表单型服务端调用需提供合法来源、使用已认证 Bearer，或对明确端点关闭检查

Sark 先以空 next 执行 Hono csrf 检查，只在该调用外捕获上游 HTTPException 403 并转换；通过后再执行真实业务链。转换范围不包含下游业务，不嗅探异常正文或复制判定代码。接入依据是上游检查后没有响应处理，升级时以来源拒绝及业务 403 的行为测试保持该约束。[Hono CSRF 源码](https://github.com/honojs/hono/blob/v4.13.13/src/middleware/csrf/index.ts)

Vite 开发按实际对外 origin 判断，同源不需补允许项，跨源开发站点显式加入 origins，不自动信任任意 localhost 端口。JSON 仍遵守正文媒体类型和 CORS 规则，不能接受不匹配的媒体类型来绕过防护。WS 不能沿 GET 豁免，其握手规则见 [websocket.md](websocket.md)。

### Node 压缩

CompressionOptions 从 middleware 导出，由 Hono compress 的选项参数派生，包含 encoding、threshold、contentTypeFilter，保留上游类型。默认 encoding=gzip，threshold 沿上游默认 1024 字节；不另写编码协商或压缩实现。[Hono compress](https://github.com/honojs/hono/blob/v4.13.13/src/middleware/compress/index.ts)

runtime.compress 提供默认策略。显式 compress(options?) 只选择当前请求策略，完整覆盖 runtime 默认；缺省选项回到共同默认，多个显式策略按实际进入顺序以后执行者为准。Node 交付层在最终响应上执行一次 Hono 压缩，不让内外两个压缩中间件重复决定阈值。

text/event-stream、升级响应、Range 请求及 206 响应不执行框架压缩；普通响应继续遵守 Hono 对 HEAD、已有 Content-Encoding/Transfer-Encoding、阈值和 no-transform 的排除。SSE 按最终媒体类型在调用上游前排除，即使应用自定义 contentTypeFilter 也不重新启用。

SSE 不新增框架层 Vary: Accept-Encoding，其他层已有 Vary 保留。普通参与编码协商的响应按 Hono 合并该 Vary，即使当前交付 identity 也不省略。CF 不执行 Sark 压缩，显式 compress 为跳过处理；平台/CDN 的外部转换由平台交付配置管理。

### 请求绑定 Cookie 助手

server 提供 getCookie、setCookie、deleteCookie、getSignedCookie、setSignedCookie，调用形态沿 Hono helper；写/删操作合并本应用通用默认属性，签名函数使用显式配置的 cookie.secret。签名读取区分值、缺失和无效签名，保持异步。不自写 Cookie 编码或 HMAC。

删除时调用方提供与签发一致的 Path/Domain，框架不能从请求头推断历史属性。JWT、OAuth、visitors 各自使用专用规则；不通过扫描 Set-Cookie 强行改写。

### 不依赖请求上下文的 Cookie 工具

`@olivaw/sark/utils` 直接聚合 Hono 纯函数，确切导出为：

```ts
export {
  parse as parseCookie,
  parseSigned as parseSignedCookie,
  serialize as serializeCookie,
  serializeSigned as serializeSignedCookie,
} from 'hono/utils/cookie'

export type { Cookie, SignedCookie, CookieOptions, CookieConstraint } from 'hono/utils/cookie'
```

- `parseCookie(cookie, name?)`：解析请求 Cookie 字符串，返回名称到字符串的 Cookie 映射；name 只过滤结果，不改成单值返回
- `parseSignedCookie(cookie, secret, name?)`：异步返回 SignedCookie 映射；有效项为字符串，验签失败为 false，缺失或无有效签名格式的项按上游规则省略
- `serializeCookie(name, value, options?)`：生成一个 Set-Cookie 字段值，保留上游名称前缀约束泛型，返回 string
- `serializeSignedCookie(name, value, secret, options?)`：生成签名后的字段值，返回 `Promise<string>`

cookie/name/value 为字符串；签名函数的 secret 显式接受 string 或 BufferSource，options 沿上游 CookieOptions（包括 maxAge 的秒单位）及适用的 CookieConstraint。默认值、编码和异常保持上游契约，不自写 Cookie 语法或 HMAC。[Hono Cookie 工具](https://github.com/honojs/hono/blob/main/src/utils/cookie.ts)

这些函数不读取应用配置、密钥或当前请求，不写响应，也不解析 Set-Cookie 响应头。调用方需要属性时显式提供 options；应用默认 Cookie 属性由 server 的请求绑定助手处理。

## SSE 声明与服务端

.sse.ts 表示 GET 订阅端点，与 .get.ts 同路径报冲突：

```ts
export default route()
  .validate({ query: ClockQuery })
  .events<{ tick: { time: number } }>({ heartbeat: 15000 })
  .handler(() => ({
    async onOpen(stream) {
      await stream.send('tick', { time: Date.now() })
    },
    onClose(stream) {},
    onError(stream, error) {},
  }))
```

顺序为 route → validate（可省）→ events → handler。事件表是事件名到 JSON 载荷的类型映射。

SseStream 提供异步 `send(event, data, { id?, retry? }?)`、signal 和 close。send 复用 Hono 标准事件流编码，受背压约束；id/retry 遵循事件流语义，retry 为毫秒。heartbeat 默认 15000 毫秒，false 关闭；使用注释帧，背压时不积压心跳。

onOpen 返回后不自动结束连接。断开、close、排空或不可恢复错误结束；框架捕获回调异常和 Promise 拒绝，跟踪回调返回的异步操作并在关闭时清理。提交头前准入失败用 HttpError/Response；提交后不能改状态，不输出内部异常。

HEAD 执行准入与输入校验，不启动生产者/心跳。每次建连和重连重新认证、授权与限流，不按每个事件重复入口限制。不进入页面缓存，Sark 跳过 text/event-stream 压缩。Node/Workers 均接对应宿主流生命周期。

## SSE 客户端

client.sse(path, options?) 只接受 SSE 路径，query/params 必填性按 endpoint 派生，不开放正文。普通类型化 get 排除 SSE，head/requestRaw 保留元信息与原始用途。

返回 SseConnection，提供 `on(event, handler): unsubscribe`、`onError(handler): unsubscribe`、close。事件名 error 与连接错误通道分开。初次 HTTP 非 2xx 通过 onError 报告 HttpError；已建连接的错误也交给句柄，不伪装成普通请求 Promise。

底层使用现有 HTTP 传输读取标准事件流，支持头和异步凭据工厂。重连遵循 retry、Last-Event-ID、204 停止；每次重连取得当前凭据，取消沿 init.signal，close 后停止重连。

订阅在 Effect 或明确业务生命周期中建立并清理，不在 React render 或 SSR Loader 自动订阅。框架不把 SSE 事件接成页面导航或业务状态。

## 验证

验证实际输入、表示与类型派生，包括三种正文字段互斥、普通值/显式响应、Accept 排除优先、原始 Response 的 unknown、可选调用参数、完整前缀与表单多值。SSE 覆盖准入、类型、背压、重连、HEAD 和断开清理；不以接口存在或示例通过替代协议行为。

方法匹配覆盖 all、GET+all、仅 GET、SSE、业务 404、无路径、非预检 OPTIONS，以及其他方法静态路由不阻挡当前方法参数路由。来源检查覆盖代理还原 origin、允许项、缺来源、已认证 Bearer 与业务 403 不误转换。压缩覆盖显式覆盖默认、自定义宽泛过滤仍排除 SSE、适用 Vary 与 CF 不执行；客户端另验 credentials 的实例默认与调用覆盖。
