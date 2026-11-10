# 订阅文档发布

## 用途与职责

feeds 按声明发布 RSS、Atom、JSON Feed 或 OPML 文档。应用提供各格式的原生数据，框架负责配置解析、端点装配、HTTP 响应和执行作用域；序列化复用 Feedsmith。

RSS、Atom、JSON Feed 承载内容更新；OPML 承载订阅源列表，可用于导入、导出阅读列表。它们使用不同数据结构，由独立端点发布，不将文章条目转换成订阅源，也不自动在格式之间转换内容。

应用负责公开范围、查询、排序、数量、正文、作者、稳定标识和真实日期。框架不扫描页面或数据库，不创建订阅关系、推送系统、专属缓存或后台刷新任务。需要授权的文档沿应用中间件控制访问。

## 声明与公开入口

服务端入口 `@olivaw/sark/feeds` 提供 defineFeeds、FeedsDeclaration、FeedsConfig、FeedConfig、FeedFormat、FeedData、FeedOptions，并导出上游的 RssFeed、AtomFeed、JsonFeed、Opml 类型。

app.ts 使用独立具名导出 feeds。它与 database、storage 等声明并列，属于可选扩展，不成为 AppConfig 字段。集合键只用于命名和诊断，不自动成为 URL：

```ts
import { defineFeeds } from '@olivaw/sark/feeds'

import { loadArticles, loadReadingList } from './services/subscriptions'

export const feeds = defineFeeds({
  articles: {
    format: 'atom',
    path: '/articles.atom',
    load: loadArticles,
  },
  readingList: {
    format: 'opml',
    path: '/reading-list.opml',
    load: loadReadingList,
  },
})
```

上例的 loadArticles 返回 `AtomFeed.Feed<Date, true>`，loadReadingList 返回 `Opml.Document<Date, readonly string[], true>`。true 采用上游严格类型，要求协议中的必要字段；不表示上游执行完整的运行时协议校验。

每个条目选择一种格式。需要多个格式时声明多个条目，应用可复用查询函数，再分别提供原生数据；每次请求只执行被选中端点的 load，不预先生成其他格式。

声明接受对象或 `(env: Env) => FeedsConfig` 工厂。工厂沿 [configuration.md](configuration.md) 在 Node 实例创建时或 Workers 外部事件中解析；load 在实际请求中执行。导入、构建及配置解析均不查询内容。

## 配置与默认路径

每个条目具有以下配置：

- format：必填，rss、atom、json 或 opml
- path：可选的完整发布路径，以 / 开头，不包含查询、片段或路由参数
- headers：可选响应头，默认 Cache-Control: no-cache
- options：对应上游生成函数的原生选项，strict 由框架固定为 true
- load(ctx)：必填，返回所选格式的原生数据，允许 Promise，可使用 Context 中已声明的资源

省略 path 时按格式采用以下默认值：

- rss：/feed.xml，application/rss+xml
- atom：/feed.atom，application/atom+xml
- json：/feed.json，application/feed+json
- opml：/subscriptions.opml，text/x-opml

响应媒体类型均附加 charset=utf-8。每种格式的多个端点须指定互不冲突的路径；名称不会自动修改默认路径。路径规范化、默认值和响应头检查在配置入口一次完成，资源创建前进行已有方法与路径冲突检查。

headers 按大小写不敏感解析，不能覆盖 Content-Type、Content-Length、Content-Encoding 或传输逐跳头。其他实际响应头、Cookie 和应用中间件仍沿正常管线提交。

## 原生数据与应用控制

FeedData 将各格式对应到上游原生类型：

- rss：RssFeed.Feed<Date, true>
- atom：AtomFeed.Feed<Date, true>
- json：JsonFeed.Feed<Date, true>
- opml：Opml.Document<Date, readonly string[], true>

FeedConfig 以 format 区分 load 的返回类型与 options；不另建共用内容模型，不筛掉上游标准字段或命名空间。应用需要自定义 OPML outline 属性时，沿上游 extraOutlineAttributes 选项交付。

下面展示应用查询公开文章后生成 Atom 数据的方式。posts、siteInfo 及发布状态均属于应用；siteInfo 保存该订阅的稳定 ID、标题、作者与真实资料更新时间：

```ts
import { defineFeeds } from '@olivaw/sark/feeds'
import { and, desc, eq } from 'drizzle-orm'

import { posts } from './db/schema'
import { siteInfo } from './site-info'

export const feeds = defineFeeds((env: NodeJS.ProcessEnv) => {
  const self = new URL('/articles.atom', env.SITE_ORIGIN).href
  return {
    articles: {
      format: 'atom',
      path: '/articles.atom',
      async load(ctx) {
        const articles = await ctx.var.db
          .select()
          .from(posts)
          .where(and(eq(posts.status, 'published'), eq(posts.visibility, 'public')))
          .orderBy(desc(posts.publishedAt))
          .limit(30)
        return {
          id: siteInfo.feedId,
          title: { value: siteInfo.title },
          authors: [{ name: siteInfo.author }],
          updated: articles.reduce(
            (latest, article) => (article.updatedAt > latest ? article.updatedAt : latest),
            siteInfo.updatedAt,
          ),
          links: [{ href: self, rel: 'self' }],
          entries: articles.map((article) => ({
            id: `urn:uuid:${article.id}`,
            title: { value: article.title },
            updated: article.updatedAt,
            published: article.publishedAt,
            links: [{ href: new URL(`/articles/${encodeURIComponent(article.slug)}`, self).href }],
            content: { value: article.html, type: 'html' },
          })),
        }
      },
    },
  }
})
```

示例的文章 ID 为 UUID，日期字段为 Date，html 为应用准备的正文。SITE_ORIGIN 由运行环境提供，缺失或无效时 URL 构造直接失败。路径、self 链接和文章链接分别由应用给出；框架不从请求 Host 猜测公开域名，不自动改写原生文档里的地址。

应用查询或返回哪些条目，输出就包含哪些条目；后台页面不会因为存在路由而被加入。分类、过滤、数量和排序均由查询或应用转换控制。框架不填入当前时间、虚假作者或临时 ID，也不默认写入生成器品牌。

RSS 命名空间、Atom 文本类型、JSON Feed 扩展及 OPML 嵌套结构沿上游契约使用。框架不抓取正文、不渲染 Markdown、不清洗或改写业务 HTML。

## HTTP 与生命周期

各端点支持 GET/HEAD，其他方法沿已有 405/Allow 机制处理。HEAD 执行相同处理后剥离正文，不另建内容快照或读取缓存。

端点复用普通 HTTP 处理流程、应用请求策略、全局中间件及资源作用域，不借用文件路由的目录作用域。Node 开发、生产与 Workers 使用同一声明；关闭页面或 API 文件扫描仍可独立发布文档。

load 可读取 ctx.req.raw.signal；框架在调用前和结果返回后检查所属请求的取消状态，取消后不继续生成。应用异步查询仍由所属执行作用域跟踪，不能把发出取消信号当作查询已经结束。

XML 使用上游字符串生成，JSON Feed 使用上游生成的对象再 JSON.stringify。应用限制实际取数规模；不宣称具备流式文档生成能力，不自动缓存结果、返回 304 或接入 SSR 页面缓存。固定文件可沿 publicDir 交付；动态查询与生成计入实际平台用量。

## 错误与组织

原生数据的必填字段由上游严格类型在编译时检查，不据此声称进行了完整的运行时协议验证。应用负责校验来自数据库或外部服务的业务数据；框架不重复维护上游字段规则。配置错误、应用取数异常和上游生成错误向已有错误边界传播，不返回空文档掩盖故障。

实现位于 features/feeds，公开入口为 entries/feeds.ts，内部装配使用 runtime/feeds。声明入口只交付配置和原生类型，运行时装配才加载 Feedsmith；没有实例服务、请求绑定或后台句柄，不扩张核心 AppConfig。

## 验证

- 四种格式的真实文档、媒体类型、默认地址、地址覆盖和多端点冲突
- 原生字段、命名空间、附件 MIME 类型、内容和来源链接保持完整
- 对象与环境工厂、请求上下文资源、生成类型与按需依赖隔离
- GET/HEAD/405、应用授权、响应头、空内容及故障和取消传播
- Node 开发与生产、真实 workerd，以及跨事件配置隔离

XML 测试解析实际内容，接受 CDATA、实体转义等合法表达；不以标签存在、固定成功值或构建通过代替功能验收。

参考：[Feedsmith 生成接口](https://feedsmith.dev/generating)、[Feedsmith 严格类型](https://feedsmith.dev/generating/strict-mode)、[RSS 2.0](https://www.rssboard.org/rss-specification)、[Atom RFC 4287](https://www.rfc-editor.org/rfc/rfc4287.html)、[JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/)、[OPML 2.0](http://opml.org/spec2.opml)。
