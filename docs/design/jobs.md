# 后台任务与调度

## 声明与服务

任务独立具名导出 jobs，框架负责注入资源、记录错误、跟踪返回的工作和停止。应用定义任务业务，不手工启动计时器。

```ts
import { defineJobs } from '@olivaw/sark/jobs'

export const jobs = defineJobs([
  {
    name: 'cleanup',
    schedule: '0 3 * * *',
    timezone: 'Asia/Shanghai',
    handler: async ({ db, signal, logger }) => {
      await cleanExpiredRecords(db, signal, logger)
    },
  },
])
```

name 唯一。共同字段为 name、handler、可选 timeout（毫秒）。handler 返回 `void | Promise<void>`，JobContext 提供 signal、logger、任务名及本应用实际启用的服务级资源，例如 db、storage、stats、metrics。

未声明能力就没有对应属性。任务不是 HTTP 请求，不带隐式 Cookie、登录身份或 visitor；需要 stats 去重时显式提供可信主体。instance.stats 与 JobContext.stats 为同一应用的服务级入口。

## Node 调度

Node 字段为 schedule、timezone、preventOverlap、runOnInit：

- schedule 为五段 cron，或 { interval } 固定延迟，interval 为毫秒
- timezone 默认进程时区；cron 的 0/7 均为周日
- preventOverlap 默认 true，当前调度实例上次尚未结束时跳过
- runOnInit 默认 false，启动就绪后调用同一执行入口，遵守相同重叠保护
- timeout 默认无，不表示可以无限拖延应用关闭

日历解析、下一时点、触发、暂停/恢复和停止复用 Croner。创建时准备暂停的调度器并立即登记释放，全部准备成功且应用就绪后激活。重叠保护由自动、启动及手动执行共用的入口负责，不再叠加 Croner protect；Sark 同时负责业务上下文、错误、取消与在途任务登记。固定延迟在上次实际结束后再等 interval，不转换成 cron。

```ts
interface JobHandle {
  readonly name: string
  pause(): void
  resume(): void
  stop(): Promise<void>
  run(): Promise<void>
  isExecuting(): boolean
}
```

instance.jobs.get(name)/list() 提供 Node 句柄。pause 只暂停后续触发，resume 恢复；stop 停止调度并按预算等待，不可恢复。run 立即执行但仍遵守重叠保护，跳过按日志/指标表达。isExecuting 回答 handler 是否仍执行，暂停后可能为 true。

## Workers Scheduled

CF 声明使用 onCron，不接受 schedule、timezone、preventOverlap、runOnInit：

```ts
export const jobs = defineJobs([{ name: 'cleanup', onCron: '0 3 * * *', handler: cleanup }])
```

onCron 匹配 ScheduledController.cron 原字符串。实际触发只由有效 Wrangler triggers.crons 配置，采用平台 UTC 与星期语法，不把 Node cron 原样换算成另一种含义，也不在 Worker 创建常驻调度器。

Wrangler 配置仅由官方 Cloudflare 接入读取，Sark 不保存第二份 triggers 或对照整张触发表。生成时诊断静态可知的 Node 专属字段和缺少 onCron；运行期解析完整任务声明，实际投递的 cron 没有对应任务时报错。平台漏配 trigger 或配置了从未投递的额外 trigger，不由 Sark 在构建时保证诊断。

同一 cron 可对应多个具名任务，分别建立上下文、等待返回工作，记录各自结果；任一任务失败均向平台传播错误，不吞掉异常后报告成功。

CF 不暴露能假装控制所有 Worker 的持久 JobHandle。启停和频率在部署配置中管理。平台允许重复/重叠执行，本框架不提供全局互斥、恰好一次或自动业务重试。

## 执行、取消与排空

执行器在 handler 前建立所属应用作用域，登记实际返回的 Promise，统一记录开始/结果。timeout 到期发取消信号并记录未完成，不把它当作 handler 已结束，也不提前解除 Node 重叠保护。

Node 错误记录后调度器继续，手动调用 run 失败时，返回的 Promise 拒绝。CF 通过 waitUntil 跟踪 handler 返回的 Promise，遵守平台执行期限并传播失败。应用自己脱离返回链启动的副作用不在跟踪保证内。

Node 应用关闭先停止触发，在 application.md 规定的 deadline-reserve 前等待在途任务；等待预算耗尽后再发取消信号，按剩余预算处置未结束工作及释放资源，不在关闭开始时立即取消所有 handler。任务自身 timeout 可更早触发取消，是独立条件。Croner.stop 只停触发，等待由 Sark 完成。

单独 stop 使用宿主相同的总预算和等待/取消顺序；应用已在 draining 时使用剩余预算，不重新获得完整期限。停止流程返回不把未响应取消的 handler 当成已结束，实际工作仍按生命周期跟踪，借用资源不因发出信号而提前释放。

## 多副本与业务边界

Node 多副本优先安排一个独立任务运行单元，Web 副本不启用相同调度；可通过相同声明的环境工厂返回不同任务列表实现，不动态改变入口导出。

需要持久队列、可靠重试或跨执行协调时明确使用相应服务，基础调度不模拟这些能力。扣费/发货等业务仍依赖自身幂等和数据约束，调度器互斥不能替代业务正确性。

## 观测

基础日志始终记录任务名、耗时、结果和取消；启用 metrics 后才接 jobs_runs_total、jobs_running、jobs_skipped_total。没有指标不影响任务运行。

## 验证

验证 Node 日历/固定延迟、启动执行与手工执行的共同保护、超时仍在途、停止资源顺序；CF 验证声明目标、实际 Scheduled 分发、未知 cron、bindings 和失败传播。stats 等服务级入口也进入真实任务链路，不只在类型上添加字段。
