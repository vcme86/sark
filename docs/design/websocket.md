# WebSocket

## 文件与声明

.ws.ts 使用和其他 API 文件相同的路径、参数、前缀与作用域。route/validate 完成握手输入，handler 决定是否升级：

```ts
export default route()
  .validate({ query: HandshakeQuery })
  .handler(async (ctx) => {
    const identity = ctx.var.auth.identity
    if (!identity) throw new HttpError(401, 'Unauthorized')
    if (!identity.roles?.includes('admin')) throw new HttpError(403, 'Forbidden')

    return {
      onOpen(socket) {},
      onMessage(socket, message) {},
      onClose(socket, code, reason) {},
      onError(socket, error) {},
    }
  })
```

例中 HandshakeQuery 与授权规则属于应用，auth 是已声明的第一方服务。返回 Response/抛 HttpError 表示普通 HTTP 拒绝；返回连接回调表示接受升级。

## 握手与响应准备

握手走共同请求 ID、安全头、客户端地址与外部 origin 还原、所选资源、CORS、身份解析、CSRF 来源防护与业务中间件。所有授权在升级决定前完成；跳过正文限额和压缩，不默认套全局 HTTP 限流。需要连接准入限流时可显式安装。

尾斜杠/大小写按共同规则匹配，不产生 308。拒绝升级时返回 HTTP 状态与正文，不能用断开 TCP 代替。

Cookie、关联头和 CORS 等必须在升级前准备。CF 升级 Response 有不可变头限制，不能继续执行普通 HTTP 的后置 setHeader。[Hono WebSocket 接入](https://hono.dev/docs/helpers/websocket)

来源防护不沿 HTTP GET 的 CSRF 豁免。Origin 存在时，按框架还原的外部 origin 或有效 csrf.origins 精确允许项检查；Origin: null 默认拒绝。检查失败使用 403 与 csrf_forbidden。Origin 缺失的非浏览器连接可以进入正常握手认证与业务授权，不强迫使用 Bearer；Origin 本身不是非浏览器身份认证。false 关闭对应来源检查，CORS 与业务授权仍独立生效。[RFC 6455 §10.2](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2)

## Socket 与事件

```ts
interface Socket {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  readonly signal: AbortSignal
  readonly readyState: number
}

interface SocketHandlers {
  onOpen?(socket: Socket): void | Promise<void>
  onMessage?(socket: Socket, data: string | Uint8Array): void | Promise<void>
  onClose?(socket: Socket, code: number, reason: string): void | Promise<void>
  onError?(socket: Socket, error: unknown): void | Promise<void>
}
```

文本和二进制按上游接入规范化，onMessage 默认并发，不等待前一条 Promise 后才派发下一条。需要业务顺序时应用自己安排，不默认创建串行队列。

Node 开发与生产均由 ws 在接收层限制单条入站消息为 1 MiB，超限时关闭连接，状态码为 1009。Workers 由平台限制入站消息大小。

send 返回 void 表示向平台提交发送，不表示字节已发送完毕或对端已收到。框架不额外建立无界发送队列，也不承诺两目标统一的背压、投递确认或缓冲上限。平台发送错误进入连接错误处理，不伪造发送成功；需要消费确认、消息持久化或持续大流量控制时，由应用明确设计消息协议。不为此增加 Node 专属 bufferedAmount 到共同 Socket 接口。

框架捕获同步异常与返回 Promise 的拒绝，记录并交 onError；onError 自身异常记录且不递归。业务消息异常默认不强制断开，传输不可恢复错误关闭连接。

返回的 Promise 加入所属连接/应用的在途跟踪；应用自行脱离返回链启动的副作用不在保证内。每个回调建立正确日志、取消和服务作用域，不借用最近创建应用。

## 资源和关闭

连接有独立 signal，断开或排空触发。发送关闭帧后等待对端完成关闭握手，Node 按应用剩余预算强制终止；没有额外固定五秒。

握手结束不提前释放连接仍使用的资源。Node 借用应用池，CF 保留所属连接环境的 binding；不能把一次短事务/请求私有连接交给整个长连接。关闭回调错误不阻断其他连接释放。

## 两个平台与开发接入

Node 生产与 Vite 开发复用桥接实现，每个应用实例拥有自己的底层 WebSocket 引擎。存在 `.ws.ts` 路由时需安装可选 peer `ws`；无该路由时不加载此依赖。Vite 的 HMR 与启用 WS 的代理先确定归属，其余升级再按共同路径规则交给 Sark；HTTP-only 代理不占用 WS 路由。两种 Node 接入共享握手、包含头与正文的 HTTP 拒绝响应、事件派发和排空。

Workers 采用平台原生 `WebSocketPair` 与 101 Response 挂载机制（提交带 `webSocket` 的 101 Response）。握手接受时将事件服务释放移交连接关闭处理，避免连接建立时即时销毁。原生接受与 101 响应准备成功后启动一次 onOpen；其异步错误不能改写已接受的握手。平台连接工作不伪装成常驻 Node server 的 shutdown，不引入 Node 专有协议依赖。

负载均衡不会逐条迁移已建立连接，重连重新准入。框架不默认提供跨实例广播、持久会话、Durable Object 房间或消息总线。

## 验证

Node 开发/生产、CF 分别验证升级接受与 HTTP 拒绝、输入与来源、初始化、文本/二进制、异步拒绝、资源保留、断开及排空。仅 app.fetch 的外部宿主调用不等于其 WS 升级也已接入。
