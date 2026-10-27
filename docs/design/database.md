# 数据库与持久化

## 三条使用路径

Sark 直接提供绑定实际驱动的 Drizzle 实例，不另建 ORM。

- Node + better-sqlite3：本地 SQLite，同步事务，适合独立应用
- Node + postgres.js：PostgreSQL，应用级连接池，单实例和多副本均可使用
- Workers + D1：平台 binding，SQLite 方言、异步访问，按 D1 的实际批量能力操作

不内建 CF 直连 PostgreSQL、Node 远程 D1、跨机器共享 SQLite 文件、分片或读写路由。选项描述实际驱动，不重复填写可能矛盾的 dialect。

Drizzle 和 Node 数据库驱动作为可选 peer 依赖，应用安装所选路径需要的包；框架开发依赖提供完整验证环境。SQLite 类型使用 @types/better-sqlite3，D1 类型引用 Cloudflare 官方的 @cloudflare/workers-types；这些类型依赖也按所选入口隔离，不向 Node 应用注入 D1 全局声明。

## 声明

```ts
import { defineDatabase } from '@olivaw/sark/db/sqlite'

import * as schema from './db/schema'

export const database = defineDatabase({
  filename: './data/app.sqlite',
  schema,
})
```

SQLite 选项为 filename 和可选 schema。filename 相对 Node 应用运行根目录解析；父目录、权限和持久卷由部署准备，不把数据库默认写入构建产物目录。

连接初始化启用外键；独立 Node 的可写文件数据库采用 WAL，锁等待沿 better-sqlite3 默认 5000 毫秒。`:memory:` 数据库保留内存日志模式，不承诺 WAL。保持原生同步事务与单写入者约束，不把锁等待说成并行写入，也不另建通用 PRAGMA 配置面板。[better-sqlite3 使用说明](https://github.com/WiseLibs/better-sqlite3#usage)、[连接选项](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#new-databasepath-options)

PostgreSQL 从 db/postgres 导入同名函数：

```ts
type Env = NodeJS.ProcessEnv

export const database = defineDatabase((env: Env) => {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return { url, schema, pool: { max: 10, idleTimeout: 30000, connectTimeout: 5000 } }
})
```

url 必填，pool.max 默认 10、idleTimeout 默认 30000 毫秒、connectTimeout 默认 5000 毫秒。适配转换到 postgres.js 的原生单位，不把毫秒直接传给其秒字段。Node 环境变量在工厂中检查，Env 不声明为已保证存在的字符串；完整环境约定见 [application.md](application.md)。

max 必须为正整数；idleTimeout、connectTimeout 为非负有限毫秒数，0 按上游语义关闭对应计时器。单位转换保留小数，不将应用指定的时长向上取整。

D1 从 db/d1 导入。以下是另一个 Workers 工程的示例，Env 使用其 Wrangler 生成类型，不是上面 Node 示例的 ProcessEnv：

```ts
export const database = defineDatabase((env: Env) => ({
  binding: env.DB,
  schema,
}))
```

Env 中 DB 使用 Wrangler 生成的 D1Database 类型。实际 binding 从当前事件取得，不从字符串环境猜测、不创建池。Node 声明用于 CF 或 D1 声明用于 Node 都报目标错误。

一个应用声明一个主 database。具名文件存储不是额外数据库配置；框架不借此提供跨库协调。

## 资源与类型

ctx.var.db、instance.db 及已选任务/检查上下文中的 db 是实际 Drizzle 实例。类型由具体声明与 schema 推导，保留关系查询、事务和返回值差异；不向应用暴露方言联合或 any。

schema 是实际导入的 Drizzle 对象，同时用于创建运行时实例和推导类型。可以在工厂中引用静态 schema，但构建不执行工厂。生成资源类型只从声明的资源结果派生，不读取包含认证/统计服务的整份 AppInstance。

未声明数据库时，相应 db 属性不存在，不注入 undefined 或空实例。需要数据库的配置回调通过 resources-types 使用它；没有数据库的应用不能编译出无条件 db 调用。

## 生命周期

Node 在创建阶段建立连接/池，按所选驱动验证必需配置与可用性；失败触发已建资源逆序回滚。长期连接由数据库资源管理，认证因素、统计与任务借用，不另开连接池。

排空停止受理新请求后，已受理工作继续使用数据库。使用者结束后才释放，超时按共同预算强制处置并记录未完成工作。HMR 不在旧业务仍执行时直接把池交给新实例。

D1 没有 Node 池的创建/关闭；装配只将当前环境的 binding 接入 Drizzle。缓存静态模块不等于可以永久捕获第一次事件的数据库。

## 事务保持原生语义

PostgreSQL 使用异步事务回调，事务内查询都使用 tx：

```ts
await ctx.var.db.transaction(async (tx) => {
  await tx.insert(users).values({ name })
})
```

better-sqlite3 使用同步事务回调，不接受 async：

```ts
const created = ctx.var.db.transaction((tx) => tx.insert(users).values({ name }).returning().get())
```

D1 使用受支持的 batch，不伪装成交互式事务回调。SQL 执行错误使整个 batch 回滚；条件更新零行是正常执行结果，应用或适配须读取并判断它，不能把放进 batch 当成全部条件已满足。[Drizzle D1](https://orm.drizzle.team/docs/connect-cloudflare-d1)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

请求取消不自动回滚已经提交的写入，也不保证目标驱动能取消正在执行的查询。需要取消时使用该驱动真实支持的机制。

## 框架专用表与应用模型

认证和 stats 可以提供默认专用 schema 与官方适配，应用选择后纳入自己的迁移。框架不接管用户、文章、阅读进度或其他业务表。

默认表使用固定 sark_ 前缀，不提供第二套动态前缀配置。兼容定制通过传入应用自己定义的 Drizzle 表对象实现；对象属性表达逻辑字段，物理表/列名由应用定义。适配使用实际表对象，不拼接用户提供的名称字符串。

默认 schema 模块可以直接被 drizzle-kit 的 schema 入口导入/再导出。SQLite 与 D1 共用 SQLite 表定义，PostgreSQL 使用自己的类型；导出路径由相应领域文档明确。

迁移工具负责实际 DDL、重名及数据库约束错误；装配对同一应用中已知的冲突声明、所需映射遗漏和表对象结构不兼容给出诊断。Drizzle 表对象与 database.schema 不证明物理迁移已执行，装配不因此扫描实际数据库的表结构或额外探表；实际缺表/缺列由迁移或真实 SQL 操作报告。不自动接管同名现存表，不以 CREATE IF NOT EXISTS 掩盖缺列/约束，也不声称能识别一个结构完全相同但业务用途不同的表。

普通应用使用默认适配不必编写存取算法；传入不同模型时，自定义适配仍须满足专用原子契约。框架不在生产启动时自动改表，不提供查询缓存、种子系统或跨存储事务。

## 部署

单进程 SQLite 的文件需要持久目录及备份；多台机器不打开同一个网络文件。多副本 PostgreSQL 的池容量按所有副本合计，留出维护和其他客户端连接。

## 验证

验证覆盖三种真实驱动的读写、事务、schema 类型、失败回滚与释放。官方因素/统计适配在目标后端复用契约测试，不能用内存替身代替数据库并发语义。

SQLite 分别验证可写文件的 WAL、外键约束、默认锁等待及内存库的实际日志模式；不以配置字段存在代替连接初始化生效。
