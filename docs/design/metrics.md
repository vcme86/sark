# Node 运行与应用指标

## 范围与选择

metrics 是独立可选的 Node Prometheus 服务。它提供应用 Counter/Histogram/Gauge，以及可关闭的 V8、事件循环、GC、CPU 等进程观测。未声明时不创建 Registry、采集器或端点，也没有空 metrics 服务。

采用 @prometheus-io/client（原 prom-client）完成计量、Registry、文本格式化和运行时采集。Sark 负责路由模板、请求/任务/WS 计量位置、所有权与端点，不重新实现采集器。[上游客户端](https://github.com/prometheus/client_js)

Workers 使用平台日志、请求/CPU/错误观测，不用随机实例的 /metrics 冒充全应用总量，也不为业务计数另建遥测平台。需要 stats 的业务计数与本模块分开。

## 声明

```ts
import { defineMetrics } from '@olivaw/sark/node'

export const metrics = defineMetrics({
  path: '/metrics',
  runtime: true,
  eventLoopPrecision: 10,
})
```

MetricsConfig 包含 path、runtime、buckets、eventLoopPrecision、gcDurationBuckets、auth(request)。path 默认 /metrics，runtime 默认 true；请求桶默认 [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10] 秒；事件循环精度默认 10 毫秒；GC 桶默认 [0.001,0.01,0.1,1,2,5] 秒。

不增加统一采样周期。默认指标抓取时取值，GC 用 observer，事件循环按上游精度。字段名与外部指标格式沿上游/Prometheus 习惯，不做全局单位重命名。

## 应用 API

instance.metrics、ctx.var.metrics 与 JobContext.metrics 在启用时提供同一服务：

```ts
interface MetricSpec {
  name: string
  help: string
  labels?: string[]
}

interface HistogramSpec extends MetricSpec {
  buckets?: number[]
}

interface Counter {
  inc(labels?: Record<string, string>, value?: number): void
}
interface Histogram {
  observe(value: number, labels?: Record<string, string>): void
}
interface Gauge {
  set(value: number, labels?: Record<string, string>): void
  inc(labels?: Record<string, string>, value?: number): void
  dec(labels?: Record<string, string>, value?: number): void
}
```

服务提供 counter(spec)、histogram(spec)、gauge(spec)。Counter 处理 _total 后缀，声明标签后每次必须提供同名标签；同规格重复声明复用，同名不同类型/标签/桶在实际注册时诊断。

框架标签采用有限集合：http_requests_total 的 method/route/status；http_request_duration_seconds 的 method/route；http_active_requests；ws_connections_active；jobs_runs_total、jobs_running、jobs_skipped_total 的 job/结果。未匹配路由记 `/*`，不把原始 URL 参数或用户 ID 放进标签。

应用负责自定义标签基数，不将访客标识当作 Prometheus 用户标签。

## 采集所有权

应用 Registry 随实例创建和释放。运行时采集按 Node 进程由宿主创建一次，HMR 不重复建立 observer/监测器，输出时与应用 Registry 组合，不维护第二份计数。

第一次启用 runtime 时开始；关闭应用只移除其端点/业务 Registry，已经启动的进程采集继续到宿主退出。改变运行时采集配置或彻底停止需重启宿主。上游没有统一 dispose，清 Registry 不等于关 observer；不调用私有接口伪装完成释放。

HTTP 结束时记录外部 HTTP 请求，流结束计时，内部 API 不重复增加外部活跃请求。任务/WS 只在其实际启用时接计量，任务生命周期不依赖指标。

## 暴露

端点位于公共前置处理后、业务管线前，默认部署层限制来源；可选 auth(request) 独立判断，false 为 401，不依赖业务认证/CSRF/限流。内容为 text/plain; version=0.0.4，Cache-Control:no-store；实际路径参与冲突检查。

“部署层限制”需要实际配置代理、防火墙等规则，框架不自动建立。监听公网且没有这些限制或 auth 时，已启用的指标端点可被公网访问。

## 验证

验证真实计量、标签/规格冲突、外部 HTTP 请求单次计数、流完成、Registry 隔离、HMR 和进程采集所有权。未启用应用和 CF 不加载客户端。指标不作为排空依据，生命周期使用自己的在途记录；框架不做远程写入、聚合或持久化。
