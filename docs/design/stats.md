# 具名计数与主体去重

## 能力范围

stats 是可选的基础工具：显式增加一次、按稳定主体去重、读取应用选定范围。它不自动采集全站页面/API，不保存通用事件正文，不提供画像、漏斗、会话、任意历史回放或报表系统。

主要价值是共同的类型化计数、原子写入、精确主体去重和读取。应用已有 articles.viewCount 且只需加一时，直接使用 Drizzle 往往更简单；没有既有表、希望统一管理若干计数时也可选择本能力。

visitors、登录身份、业务提交和 stats 各自独立。阅读进度等业务仍使用应用 API 和业务模型，不因使用 visitor 就自动进入统计。

## 声明

```ts
import { defineStats } from '@olivaw/sark/stats'
import { sqlStats } from '@olivaw/sark/stats/sqlite'

export const stats = defineStats({
  store: sqlStats({ database }),
  counters: {
    articleViews: { uniqueBy: 'visitor' },
    downloads: { uniqueBy: false },
    importedReaders: { uniqueBy: 'subject' },
  },
})
```

counter 名称保留字面量，increment/read 的 name 是这些名称的联合。store 必填，可选官方 SQL 或专用自定义实现，不自动发现数据表。

uniqueBy 必须明确选择 false、visitor、user、client 或 subject。false 只计次数；visitor/user/client 自动解析当前请求身份；subject 由服务端调用者显式提供。

client 身份在所属声明中提供映射：

```ts
identities: {
  client: async (context) => {
    return lookupVerifiedApiClient(context)
  },
}
```

签名为 `(context: StatsIdentityContext) => string | null | Promise<string | null>`。上下文包含当前 Request、logger、signal 及已声明资源；不反向依赖整个 stats 服务。返回的是服务端已验证的调用方 ID，不能把未经验证的任意请求头直接称为身份。

visitor/user 分别需要 visitors/auth 声明，client 需要上述映射，缺少依赖在资源创建前拒绝。subject 和 false 不要求任何请求身份能力。

## 请求与服务级入口

请求使用 ctx.var.stats；实例与后台使用 instance.stats、JobContext.stats。三个入口使用同一应用的 store 和计数项，未启用时类型与运行都不提供 stats 属性。

请求绑定服务的自动模式从上下文取主体，调用为：

```ts
await ctx.var.stats.increment('articleViews', { key: articleId, period: 'day:2026-10-23' })
const result = await ctx.var.stats.read('articleViews', {
  key: articleId,
  period: 'day:2026-10-23',
})
```

key 是应用资源键，period 是应用选择的非空周期标识；省略 period 表示累计范围。框架不指定业务时区、不解析这些字符串，也不默认最近七天。key 使用应用选定的资源标识，站点级统计也使用明确的 key。

显式主体结构为 `{ kind: string; id: string }`，visitor/user/client 是保留的对应身份类别，其他类别由应用命名。subject 模式的 increment 必须提供 subject；普通计数不接收 subject；自动模式的请求调用不允许覆盖绑定身份。

服务级 increment 对所有去重项要求显式主体，自动来源模式还检查 kind 与声明一致。它不能借用最近一次 HTTP 请求，也不为后台工作创建游客。仅使用自有后台主体时选择 subject，无须配置 visitors/auth。

read 返回 count；声明去重的项还返回 uniqueCount。没有记录返回对应零值，不把空记录当存储故障。name、key、period 共同决定读取范围，不按单个 subject 过滤累计结果。

## 缺身份与错误

装配只保证来源声明存在，当前请求可能仍没有 Cookie、没有登录或映射返回 null。increment 在写入前报告 stats_subject_missing，不默默只加次数；stats 不调用 ensure、不自动登录或跳转。

显式主体由调用它的服务端业务负责可信性。公开 API 不能直接允许浏览器任意指定其他人的统计主体。应用选择何时增加次数、什么算有效阅读、如何授权和限流。

## 单周期语义

一次 increment 只增加一个 period。维护日、周、月和累计需要分别调用；每次保证自身一致，不保证多次整体提交。中途失败保留已成功周期，Promise.all 不会把它们变成事务，框架不自动重放。

每个 record 都增加 count；同主体重复记录仍增加次数，但 uniqueCount 不再增加。响应不确定后重试可能多计次数，唯一数继续去重。本工具不保证恰好执行一次，业务幂等和跨存储事务由业务明确实现。

不能把每日 uniqueCount 相加称为周 UV。需要精确周/月唯一数时在记录时选择对应 period；任意时间窗口分析使用应用自己的模型或专业产品。

## 专用 store

```ts
interface StatsScope {
  name: string
  key: string
  period?: string
}

interface StatsSubject {
  kind: string
  id: string
}

interface StatsStore {
  record(input: StatsScope & { subject?: StatsSubject }): Promise<void>
  read(input: StatsScope & { unique: boolean }): Promise<{ count: number; uniqueCount?: number }>
}
```

服务根据计数声明向 read 传 unique；这是内部存取输入，不允许业务读取调用随意改变计数项含义。unique=true 时返回 uniqueCount（包括空范围的零），false 时省略。这样自定义 store 不必另维护一份计数项配置。record 的累计与标记在同一原子操作内生效；并发不丢累计、不重复标记主体，故障不留下只增加 count 或只写入主体标记的部分结果。read 的两个值来自同一读取快照。

这是统计领域存取契约，不规定物理表、ORM 或保留策略。已有关系表可实现此接口；自定义 store 不需创建官方表，且不能只用普通 get/set 声称已满足并发保证。

store 声明使用 [application.md](application.md) 的延迟 create(context) 约定，在资源可用后返回 { value: StatsStore, dispose? }，可以直接借用 context.db；不能在模块导入时自行连接数据库。

框架在装配时解析 stats 计数声明，再向该领域的创建上下文提供 `requirements: { unique: boolean }`。任一计数项的 uniqueBy 不为 false 时，unique 为 true；创建器据此初始化所需存储。只传这项存取需求，不复制全部计数配置，也不依赖完整 AppInstance。该字段属于 StatsStoreDeclaration 的创建契约，record/read 的操作接口不变。

## 官方 SQL 与 schema

stats/sqlite、stats/postgres、stats/d1 导出 sqlStats({ database, tables?: { counters, subjects? } })。对应 /schema 导出默认 counters 与 subjects，物理名分别为 sark_stats_counters、sark_stats_subjects。

未传 tables 时使用默认 counters，requirements.unique=true 时再使用默认 subjects。显式 tables 表示整组自定义映射：counters 必需；unique=true 时 subjects 也必需，遗漏在服务创建阶段报配置错误，不静默混用默认 subjects。unique=false 不要求或查询 subjects。

计数记录按 (name,key,period) 唯一；主体标记按该范围加 (kind,id) 唯一。省略 period 由适配编码为累计专用值，显式 period 不与它碰撞。索引覆盖精确范围读取与主体计数，不为任意维度建立索引。

count 使用原子 upsert 加一，主体标记冲突忽略；同次 record 放入目标数据库真实事务/batch。uniqueCount 根据主体标记记录计算，不另维护可能与标记不同步的累计值。D1 零行冲突不是失败，不拿它冒充回滚条件。

只有普通计数时，只需 counters 表与迁移，不查询/要求 subjects；包含去重项时才纳入 subjects。应用的 schema 入口选择实际需要的导出。提供自有兼容 Drizzle 表对象可改物理名；不接受拼接表/列名字符串来代替映射。

默认适配、schema、迁移接入与契约测试一起提供，借用已有数据库资源，不额外建立连接。前缀、冲突和迁移责任沿 [database.md](database.md)。

装配只检查表对象映射、必要逻辑列及可知的结构兼容性；表对象不证明迁移已执行，database.schema 也不代表实际数据库的表清单。框架不为此在启动或每次请求探表。实际缺表/缺列通过部署迁移及数据库操作错误报告，保留表与操作定位，不自动建表或返回零值冒充成功。

## 保留与容量

不自动删除计数行或主体标记，不隐式创建 retention、Cron 或清理进度记录。应用通过所选 schema 和正常数据库工具决定保留，清理后的查询只代表剩余数据。

同一范围的计数和标记应按一致策略清理，活跃范围的维护与写入协调；不能只删标记，却继续宣称保留了完整历史的唯一数。

计数行数随不同 name/key/period 增长；主体标记随实际不同的 (name,key,period,kind,id) 组合增长。大量新访客每人一次时，标记数量仍接近访问量；维护多个周期还会增加写入和标记。不记录事件明细不等于没有精确去重的存储成本。

## 应用边界

公开数据入口是应用 API，没有通用 /__sark/events、默认采集脚本或每请求 SQL 事件。来源防护、认证和限流沿该 API 正常规则；框架不解释有效阅读、计费或账号迁移。

## 验证

契约测试覆盖并发累加、重复主体、范围隔离、一次 record 原子失败、读取快照及缺身份零写入。分别验证只有 counters 的纯计数、默认两表去重、自定义映射缺 subjects 的创建期错误，以及真实迁移/读写；不能拿表对象存在当作物理迁移成功。官方适配在 SQLite、PG、D1 的真实后端验证；自定义适配复用同一批开发期断言，生产不导入测试依赖。
