# Node 探针与依赖检查

## 基础探针归宿主

Node 默认 /livez 和 /readyz，由宿主读取核心同一份生命周期状态：

- liveness 表达进程能响应，不查询 DB 等依赖
- readiness 表达已启动完成、未 draining，可选依赖检查通过

runtime.probes=false 关闭，或提供 liveness/readiness 路径。它们不是 health 声明的默认开关；省略 health 只有轻量基础探针，没有依赖查询、缓存或检查定时器。

Workers 不模拟自管进程的探针。其平台调度不受某个实例 ready 控制，声明 Node health/runtime 时报告目标错误。

## 独立增强声明

```ts
import { defineHealth } from '@olivaw/sark/node'

export const health = defineHealth({
  readiness: { db: async ({ db }) => db.execute(sql`select 1`) },
  timeout: 1000,
  cache: 2000,
})
```

这是 PostgreSQL 示例，sql 为 Drizzle 导入。SQLite 按实际驱动用 get/run/all，不假定所有驱动都有 execute。

HealthConfig 包含 readiness（检查名到异步函数）、timeout、cache 和可选 auth(request)。timeout 默认 1000 毫秒，cache 默认 2000 毫秒，readiness 默认空。probes 已关闭却声明 health 是组合错误。

HealthCheckContext 提供 logger、signal 和所声明资源，例如 db；没有数据库时不出现虚构字段。检查不使用包含自身的 AppInstance。

## 执行和响应

启动未完成或 draining 立即返回 503，先于缓存；旧成功检查不能覆盖生命周期。ready 后才按依赖结果判断，任一失败即 503。

检查超时后停止等待并发出取消信号，不保证底层查询已终止。同一项检查的并发调用合并，超时后仍在执行的检查未结束时，不因后续探测重复创建查询；并发检查数与结果缓存均受限制。

限制由声明数量确定：N 项 readiness 检查，每项最多一份实际在途检查和一份结果缓存，并发与空间随 N 增长，不随探针请求数增长。不新增任意的全局检查数配置。

成功正文为 { status: 'ok' }，失败为 { status: 'unavailable', failed: ['db'] }，只暴露声明的检查名，不给内部错误。失败原因写日志。

进入 draining 后 readiness 立即 503，liveness 在进程仍能响应时保持 200。实际编排器必须配置相同路径，端点存在不等于已配置探测。

## 准入与部署

探针位于公共前置处理之后、业务认证和限流之前，避免业务 401/429 导致错误重启。默认无业务鉴权，由部署层控制访问。

框架不会自动创建网络访问限制；监听公网且未配置代理、防火墙或独立 auth 时，探针可被公网访问。需要限制时选择部署规则或下述独立校验，不强制普通单机应用管理额外令牌。

health.auth 可给两条探针增加独立校验，返回 false 为 401；它不经过业务管线，不改变 liveness/readiness 各自语义。未声明 health 时，可通过部署限制基础路径，不必只为限制来源启用依赖查询。

Node 基础 probes 实现在 adapter/node/probes，读取只读核心状态和可选检查函数；health 提供 readiness 机制，不反向导入创建器。宿主在应用资源创建前解析 health 与 probes 的组合，资源就绪后绑定检查 runner，不从 instance.definition 反查原始声明。它们不建立第二份 ready 状态。

## 验证

分别验证 Node 默认、关闭、改路径、路径冲突、health 与关闭 probes 的依赖错误、真实依赖失败/超时、缓存与 draining 优先、独立准入。CF 验证不生成这组 Node 设施。这里不建设业务健康聚合页、拓扑或自动降级。
