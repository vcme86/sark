# 公共页面缓存

## 缓存内容与启用

缓存公共 SSR 的渲染产物，减少重复 Loader 和 React 渲染。缓存产物包括未压缩 HTML 字节、状态、可复用表示头和标签；不存 Response、流或请求上下文，不缓存普通 API、DB 查询或任意函数。

页面/布局的 cache 元数据表示公开响应策略；独立 pageCache 声明决定 Sark 是否建立实例缓存。两者分开：

```ts
import { definePageCache } from '@olivaw/sark/page/cache'

export const pageCache = definePageCache({
  maxEntries: 500,
  maxBytes: 30 * 1024 * 1024,
})
```

无声明不加载 LRU、不做缓存读写、并发填充合并或正文收集，SSR 仍正常流式输出。声明后也只处理有有效页面 cache 的页面。开发环境关闭实例缓存。

默认 maxEntries=500、maxBytes=31457280、maxEntryBytes=4194304；字节数只计正文，不含对象/索引。defaultTtl 无默认，单位秒；显式填 60 只是应用选择。没有有效的正数 TTL 时不写入缓存。

## 页面策略

```ts
interface PageCacheConfig {
  ttl?: number
  staleWhileRevalidate?: number
  tags?: string[] | ((params: Record<string, string | string[]>) => string[])
  vary?: string[]
}

export const cache: PageCacheConfig | false = {
  ttl: 60,
  staleWhileRevalidate: 120,
  tags: ['site-info'],
}
```

ttl/SWR 为秒；vary 是额外参与内容匹配的请求头名。布局向下继承，页面同名标量覆盖，tags/vary 合并去重。cache=false 关闭该处继承，子级可以明确重新声明。未声明 cache 不缓存，ttl=0 不缓存。

新鲜截止是写入时刻+ttl；SWR 截止再加 staleWhileRevalidate。新鲜直接命中，SWR 内返回旧产物并触发合并刷新，超过截止按未命中。超过可用期限后不再命中；内存释放由上游按容量与 TTL 淘汰规则处理。

## HTTP 策略与资格

请求携 Cookie/Authorization 等凭据时，跳过公共实例缓存。请求 no-cache 强制渲染且不参与合并，但可写新产物；请求 no-store 同时禁止读、合并和写。

该规则也包括 visitor Cookie，因此已初始化访客的回访请求不命中 Sark 公共实例缓存。HTML 不含访客 ID 不等于请求不带 Cookie；框架不据 Cookie 名自动忽略身份，因为应用可能用它读取私人阅读进度。不增加 Cookie 分类器，公共 cache 声明不能放宽私人输出限制。

响应 private/no-store/no-cache 不进入公共实例缓存；Set-Cookie 不保存，等待者退出共享。不能仅凭旧产物自身的 ETag 判定 no-cache 响应已完成向源站的重新验证。错误响应和重定向不缓存。

页面 TTL 推导 public、max-age/s-maxage 和可选 stale-while-revalidate。应用中间件明确覆盖时按实际头决定资格/时效：s-maxage 优先 max-age，均无时使用页面 TTL。max-age=0 是立即陈旧，不等于禁止存储；max-age=0,s-maxage=60 允许共享缓存新鲜 60 秒。

显式覆盖的 SWR 替代页面值。private/no-store/no-cache 优先于数字时效。ETag 只标识表示，不决定是否新鲜。[RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html)

内部 API/远端 API 产生的私人标记和 Cookie 会收紧最终 HTML，不能通过公开页面声明把它们放宽。命中只跳过 Loader/渲染，不跳过仍适用的请求准入和授权。

## 缓存键与内容变体

键包含规范化 URL origin、pathname、query、匹配 params 与已声明 vary 维度。URL origin 是被访问站点，与发起请求来源的 Origin 请求头不同。业务查询参数不丢弃、不重排；ignore 尾斜杠模式保留不同 URL。hosts 只限制允许的主机名，不能代替按 URL origin 区分缓存。

水合载荷内嵌 URL/params/结果快照，命中直接复用，不重新生成，因此键要覆盖所有影响产物的输入。

响应 Vary 出现未预先参与匹配的内容维度，或 Vary:* 时不存储、不共享。声明 vary 只是按头值分区，不替应用判断「英文内容」或改业务语言。

只有框架明确负责重建的交付维度可不进入内容键：

- Accept-Encoding：保存未压缩字节，Node 唯一交付点按当前请求压缩，重建 Content-Encoding/Content-Length 并保留适用 Vary；不为 gzip 存第二份 HTML
- 框架 CORS：不保存其 Access-Control-* 等逐请求输出头，命中时仍按当前请求执行并重建，合并适用 Vary: Origin

应用若按 Origin 请求头改变 HTML，必须声明 vary: ['Origin']；不能因 URL origin 已入键或框架会重建 CORS 而豁免。应用自身声明的 Vary: Origin 仍是内容维度。最终 Vary 为内容维度与本次交付维度的并集，未知内容维度继续禁止存储与共享。

## 并发、流与取消

缓存填充负责执行 Loader、渲染并生成缓存产物。同一键的并发填充通过 lru-cache.fetch 合并；容量、TTL、字节计量与 dispose 也复用上游。Sark 负责缓存条件、缓存键、标签、失效版本及共享操作的取消传递，不自写 LRU。

冷请求流式输出，同时收集正文用于缓存，缓冲大小不超过 maxEntryBytes。超限时立即放弃缓存正文，原流继续。等待者等完整产物后交付；渲染失败、取消或超限时不写，等待者按自己的请求重新执行。

共享填充由缓存实例持有 signal 与期限，每个 HTTP 只取消自己的等待，单个等待者断开不取消所有人的工作。无人等待时填充/SWR 仍可完成。应用关闭和失效按工作契约取消；Node 计入排空，Workers 通过 waitUntil 接入平台事件生命周期并遵守执行期限。

输出后来发现私有时，等待者退出共享，各自执行，不能收到首请求的私人产物。

## 失效

page/cache 导出 `revalidatePath(path)`、`revalidateTag(tag)`，在当前请求/连接回调/任务作用域绑定应用。外部维护使用已启用的 instance.cache.revalidatePath/revalidateTag。

无应用绑定时助手报告调用错误；已绑定但未启用存储或没有条目时正常完成，不创建空服务。实例未声明 pageCache 就没有 cache 属性。

路径失效覆盖本应用该规范路径的查询/表示，标签失效覆盖相关路径。完成表示此实例后续请求不命中旧产物，在途旧渲染不回填；不立即重新渲染，不支持正则/通配失效。

每次填充开始时记录当前缓存版本，失效时更新版本；写入和交付给等待者之前重新检查，版本不匹配的结果直接丢弃。标签在填充开始时确定，索引与版本记录随条目和在途操作一起清理，各自受容量限制。

## 条件请求与交付头

完整产物计算弱 ETag，避免同一强验证器代表压缩前后的不同字节。新鲜命中且 If-None-Match 弱比较匹配时返回 304；Age 按真实年龄计算，命中不重置 TTL。不伪造动态页面 Last-Modified。

每次交付重建请求 ID、Cookie、连接相关头、CORS 和编码，不重放首个请求的逐请求头。产物的表示头只在其匹配维度仍成立时复用，不能让存储头覆盖本次 CORS 判定。

## 实例范围

Node 缓存只属于当前实例；多副本各自按 TTL 到期，失效不广播、不清 CDN。需要立即新鲜的页面可以关闭公共存储；跨副本失效由应用的明确外部方案处理，不默认建设消息平台。

Workers 显式声明后使用实例内 LRU，实例销毁即丢失缓存，不保证常驻、命中率或全应用失效。页面公共头可以交平台/CDN 使用，但响应有头不表示已开启平台缓存，认证页面不能盲开共享边缘缓存。

## 验证

验证 TTL/SWR、HTTP 指令、origin/query/vary、Cookie 私人输出、弱 ETag/Age、填充取消、并发失效与正文缓冲上限。未声明实例缓存时不应初始化 LRU 或收集缓存正文。

## 成本

容量与命中收益按实际页面测量；maxBytes 是正文预算，正文缓冲、在途操作与索引另有开销。页面数据生命周期和首屏正确性不能以缓存测试通过代替。
