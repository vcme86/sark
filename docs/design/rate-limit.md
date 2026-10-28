# 入口限流

## 范围与启用

入口限流保护 HTTP 请求处理成本，不代表业务配额、验证码账户尝试或集群严格总额。它独立于核心配置，按实际后端声明。

```ts
import { defineRateLimit } from '@olivaw/sark/middleware/rate-limit'

export const rateLimit = defineRateLimit({
  window: 60000,
  limit: 100,
  headers: true,
})
```

Node window 为有限正数，单位毫秒；limit 为正整数，headers 默认 true。window/limit 必填。缺省 key 使用框架确定的 clientIp，可提供 `key(ctx): string | Promise<string>` 改用已验证身份；应用不把正文自报 ID 当成可信主体。

Workers 声明 `defineRateLimit({ binding: 'HTTP_LIMIT', key? })`，从本次 env 解析平台 limiter。配额、10/60 秒周期在 Wrangler 单独配置；不接受 Node window/limit，不伪造精确剩余和重置时间。

## 公开接口

`defineRateLimit` 与 `rateLimit` 均从 `@olivaw/sark/middleware/rate-limit` 导入，选项类型随同导出：

```ts
type RateLimitKey = (ctx: Context) => string | Promise<string>

interface NodeRateLimitConfig {
  window: number
  limit: number
  headers?: boolean
  key?: RateLimitKey
  binding?: never
}

interface CloudflareRateLimitConfig {
  binding: string
  key?: RateLimitKey
  window?: never
  limit?: never
  headers?: never
}

type RateLimitConfig = NodeRateLimitConfig | CloudflareRateLimitConfig

function rateLimit(options: RateLimitConfig): MiddlewareHandler
```

Context 与 MiddlewareHandler 使用本应用的 Hono 上下文类型，保留已声明资源的类型。defineRateLimit 接受 RateLimitConfig 或沿共同声明约定的 Env 工厂，返回框架使用的不透明 RateLimitDeclaration，不是中间件；工厂的环境类型保留在声明中。rateLimit 接受实际选项，返回可直接安装的中间件。

app.ts 的固定导出名 rateLimit 是应用声明槽位，与包导出的中间件函数用途不同。同一文件需要两者时，对导入函数使用普通别名，不改变配置导出名。

## 合并与显式中间件

应用 rateLimit → scope.rateLimit → route.rateLimit 逐字段覆盖，false 关闭对应声明式策略。匹配后执行最终策略一次。局部放宽不会先被全局额度拒绝。

局部声明式 rateLimit 需要已启用对应能力，缺少时报组合错误。显式 `rateLimit(options)` 返回一个完整的 Hono 中间件，可以独立安装，不要求重复全局声明；它按注册顺序独立执行，不与声明式策略猜测合并。

```ts
import { rateLimit } from '@olivaw/sark/middleware/rate-limit'
import { route } from '@olivaw/sark/server'

export default route({
  middleware: [rateLimit({ window: 60000, limit: 20 })],
}).handler(() => ({ ok: true }))
```

每次构造的显式 Node 中间件有独立计数状态，重复安装同一个实例则共享它；不借用应用声明的计数。CF 中间件取得当前 env 的指定 binding，额度共享范围由 binding 和 key 决定，创建多个函数不产生平台侧独立额度。

Node 使用按访问清理且受容量约束的窗口状态，不在模块导入时启动清理计时器；不能以无界 Map 保存任意 IP。超过入口额度返回 429 和适用 Retry-After。Node 可报告本实例额度；平台只提供通过结果时，只给真实可用信息。CF binding 缺失或形态不符时明确报配置错误，不静默放行；静态声明与目标不符在装配时诊断。

## 响应头

Node 的 headers 默认 true，使用本实例实际窗口信息：

- RateLimit-Limit 为有效 limit
- RateLimit-Remaining 为本次判断后的剩余额度，最小为 0
- RateLimit-Reset 为距离窗口重置的剩余秒数，向上取整，不是 Unix 时间戳
- 拒绝时返回 429，并提供同样按剩余秒数计算的 Retry-After

headers=false 关闭这组自动头，包括 Retry-After；不会移除应用主动设置的头。这是框架选定的响应头格式，不表达跨实例全局配额。Workers 的 binding 只提供通过/拒绝时，不伪造剩余额度、重置时间或 Retry-After；其类型也不开放 headers 配置。

## 实际保证

Node 的窗口计数与限额判断在当前实例内生效，多副本不是全局额度。平台 limiter 在 Cloudflare location 内近似计数，也不是全球精确配额。[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

普通 HTTP 与 SSE 建连/重连执行入口限流，已建立 SSE 不逐事件计数。WS 默认不套全局 HTTP 限流，需要时在握手业务准入显式安装。进程内 SSR 调用跳过外部入口计数，但目标业务配额仍由应用判断。

MFA 的账户尝试次数使用专用原子状态，不能用这种入口近似计数替代。框架不内建分布式额度服务；启用服务时才加载状态实现或 binding 接入。

## 验证

覆盖 Node 窗口与状态容量、CF 实际 binding、声明式逐字段覆盖及 false、显式中间件状态隔离/复用、429 与适用头。验证局部放宽不被全局先拒绝，HTTP/SSE 建连与 WS/内部调用的适用范围保持一致；不把本实例或平台近似额度当作集群精确配额。
