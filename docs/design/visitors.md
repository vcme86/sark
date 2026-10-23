# 游客身份

## 用途与边界

visitors 提供浏览器的持续访客标识，供阅读进度、游客书架、唯一计数等业务复用。它不是登录身份、真实自然人证明或统计系统，不自动关联账号、不记录 PV、不写行为表。

读取或创建 ID 不启用数据库、认证、stats 或浏览器采集。应用决定如何使用这个标识、何时创建、是否合并到登录账户，以及对用户说明的用途。

## 声明

```ts
import { defineVisitors } from '@olivaw/sark/visitors'

type Env = NodeJS.ProcessEnv

export const visitors = defineVisitors((env: Env) => {
  const secret = env.VISITOR_SECRET
  if (!secret) throw new Error('VISITOR_SECRET is required')
  return { secret }
})
```

```ts
interface VisitorsOptions {
  secret: string
  cookieName?: string
  expiresIn?: number
  path?: string
  cookie?: {
    path?: string
    domain?: string
    sameSite?: 'lax' | 'strict' | 'none'
    secure?: boolean
  }
}
```

声明示例使用 Node ProcessEnv，先检查必填值；Workers 使用 Wrangler Env，见 [application.md](application.md)。

secret 显式提供，不隐式借用 JWT/通用 Cookie 密钥。默认 Cookie 名 sark_visitor，expiresIn=15552000000 毫秒（180 天），初始化端点 path=/__sark/visitor；这里的 path 是端点，cookie.path 是 Cookie 范围，默认 /。

Cookie 默认 HttpOnly、SameSite=Lax、生产 Secure、不设置 Domain。expiresIn 有限正数，服务端也验证到期时间，不只依赖浏览器 Max-Age。标识由服务端 crypto.randomUUID 创建，签名封装包含格式版本、ID 与期限；编码和签名复用 Hono helper。

更换 secret 或清 Cookie 会产生新标识。登录/退出不自动轮换 visitor，不把它写成 Identity.sub；本能力不尝试解决跨浏览器/设备同一自然人的识别。

## 请求服务

visitors 是能力声明及包入口名；ctx.var.visitor 是绑定当前请求的游客服务，提供 `readonly id: string | null` 与 `ensure(): Promise<string>`。

请求进入时只解析、验签一次已有 Cookie；无效或缺失得到 null，不自动查询 DB 或写 Cookie。ensure 复用有效 ID，否则为当前外层响应创建标识，并在同一请求中复用结果。进程内 API 调用继承同一服务，不重复签发。

需要写 Cookie 时必须在响应头提交前调用；越界明确抛 response_committed，不记录成成功。已有有效 ID 不需写头时可以直接复用。

初始化或修改 Cookie 的响应使用 no-store，不进入公共页面缓存；普通公开文章 HTML 不必因为启用 visitors 就随每人变化。不能把 ID 注入可共享的启动载荷，再期待缓存隔离自动成立。

按 [page-cache.md](page-cache.md) 的任意 Cookie 旁路规则，已初始化游客的回访请求也会跳过 Sark 公共实例缓存。页面内容可保持公开，但不意味着带 Cookie 的请求会命中；框架不自动忽略 visitor Cookie，因为应用仍可能通过它读取私人业务数据。

## 浏览器初始化

框架生成 POST 初始化端点，成功返回 204 和需要的 Cookie，Cache-Control: no-store；不返回登录身份或业务数据。它沿来源防护、正文限制及已选入口限流，不要求登录。路径和方法按有效规范化规则参与冲突检查，不保留整个 /__sark 前缀。

visitors/browser 导出 ensureVisitor(options?)，返回 `Promise<void>`；options 可提供 url、signal、credentials，缺省同源并使用本工程生成的初始化地址。helper 发送无正文 POST，不主动设置 Content-Type；缺少该头仍按 [http.md](http.md) 的规则执行来源检查。同页面并发调用合并，失败后允许重新调用；成功返回后再开始依赖游客 Cookie 的业务请求。

独立消费端或分离部署可明确提供公开初始化 URL。跨源浏览器调用时，服务端须将前端页面的 origin 加入 csrf.origins，并配置允许该 origin 且 credentials=true 的 CORS；helper 和后续业务请求显式使用 credentials='include'。CORS 放行不自动放行 CSRF。同源默认不需要增加允许项。

Cookie 范围须覆盖后续业务请求；跨站使用还需 SameSite=None 与 Secure，并受浏览器的第三方 Cookie 政策约束。跨源不一定跨站，不能把所有跨源部署都视为必须修改 SameSite。

同构 Loader/Action 不导入服务端 ensure。浏览器业务先用 helper 初始化再通过 typed client 提交；SSR 确实需要创建时，经应用 API 的服务端处理器在外层提交前调用 ensure。

## 应用业务示例

阅读进度链路为：页面选择时机 → typed client → 应用进度 API → 取得当前 visitor/user → 校验文章权限与进度 → 保存应用自己的表 → 返回业务结果。

浏览器正文中的任意 visitorId 不代替服务端 Cookie 结果。进度结构、覆盖/合并、完成条件和登录迁移由应用决定。保存进度不会自动增加阅读次数；应用需要 stats 时显式调用。

## 平台与成本

Node 与 Workers 都使用 Hono Cookie 和平台 WebCrypto，不引入通用 SessionStore 或游客数据库。每请求至多一次解析/验签，首次按需创建有 Cookie 字节与签名成本；没有数据库查询。

## 验证

验证覆盖有效/失效/过期标识、同请求与内部调用复用、Cookie 写入时机、初始化方法/路径冲突、公开页面缓存边界和独立浏览器调用。用途及 Cookie 政策由应用按实际部署决定，框架不根据模块名代替应用作判断。

跨源初始化验证无正文 POST 的来源拒绝、显式 csrf.origins 放行，以及 CORS、credentials 和 Cookie 的实际接收与后续发送；仅开放 CORS 不能使未允许的来源通过初始化。跨源同站与跨站场景分别验证，不把 204 当作 Cookie 已持久保存的证明。
