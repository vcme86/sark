# 静态文件与运行目录

## 构建文件与运行目录

构建静态文件包括 Vite 生成的内容哈希资源及 publicDir 中的文件，默认公开，不经过业务认证、CSRF、限流和业务中间件。Node 宿主执行来源检查、请求 ID、适用安全头、CORS、访问记录和压缩，开发与生产共用交付完成跟踪。

CF 使用原生 Static Assets 直接交付，静态命中不调用应用 Worker，不解析应用配置、不创建日志或业务资源。静态响应策略归平台配置；app.headers、app.cors、来源检查及 Sark 访问日志只作用于进入 Worker 的请求。公开文件需要动态授权时，应由应用下载 API 或授权直传承担，不把全部静态请求送进 Worker。

运行目录是 Node 应用显式开放的文件挂载，执行应用级请求策略和全局中间件，应用可在其中授权。应用运行文件的存储接口和上传流程见 [storage.md](storage.md)。将文件放进 publicDir 等于公开交付，不能用它保护私有文件。

## 构建文件

publicDir 以 Vite 解析值为准，默认 public，可以修改或关闭。框架不另建 static/statics 约定。具体资源布局由 [build.md](build.md) 定义。

robots.txt 等固定文件可直接放入 publicDir，沿原生交付与缓存规则。固定订阅文件也可使用该机制；动态订阅见 [feeds.md](feeds.md)。静态文件与动态端点重叠时沿现有公开文件优先级；应用应避免为同一发布 URL 同时提供两种来源。

构建文件的默认响应策略：

- Vite 生成、内容哈希包含在 URL 中的产物使用 `Cache-Control: public, max-age=31536000, immutable`
- publicDir 中未哈希的文件及 HTML 每次复用前必须验证：Node 使用 `Cache-Control: no-cache`；CF 沿平台默认 `public, max-age=0, must-revalidate`。支持时通过 ETag/Last-Modified 条件请求返回 304
- 开发环境不发送上述长期缓存策略

内容哈希产物依据 Vite 构建清单识别，不按文件名外观猜测。Node 在请求内异步读取路径与文件信息，保持条件响应对当前文件的校验，不缓存全部文件元数据。未哈希文件不设一段允许直接复用旧内容的默认时间，避免同 URL 更新后继续使用旧版本。no-cache 的验证语义见 [RFC 9111 §5.2.2.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.4)。本节只规定构建文件，不覆盖动态 SSR 页面的 cache 策略。

生产资源 URL 由 manifest 与宿主接入生成，不手写哈希路径。Node 在静态响应中应用上述默认头。CF 构建向 client 输出写入原生 `_headers`，提供默认安全头和 manifest 已确定的哈希资源长期缓存；仅在目录内没有未哈希 public 文件时使用整目录规则，避免误缓存同目录中的固定 URL。平台负责交付、条件响应、验证器及缓存，不在 Worker 中再次处理。

框架生成的 `_headers` 超过平台 100 条规则或单行 2000 字符上限时构建失败，不静默丢弃规则。大量哈希产物应与固定 URL 的 public 文件分目录，便于使用目录规则；也可提供应用自己的 `_headers`，由原生工具处理其规则与诊断。

应用在 publicDir 提供 `_headers` 时，整份文件优先，框架不覆盖或自行解析合并；应用按 CF 原生语法维护安全头、缓存和静态 CORS。`_headers`、`_redirects` 是平台配置，不作为可下载文件或应用路由。开发期支持沿官方插件的相应选项，不自行实现平台规则解析器。[CF 静态响应头](https://developers.cloudflare.com/workers/static-assets/headers/)

Node 读取构建输出；CF 官方插件将 client 输出交给平台静态资源服务，框架不要求 ASSETS binding，不读取 Worker 本地文件，也不配置 SPA fallback 代替 SSR。非根资源前缀及原生路径分流见 [deployment.md](deployment.md)。

## Node 运行目录声明

```ts
import { defineAssets } from '@olivaw/sark/node'

export const assets = defineAssets([
  { path: '/files', dir: './data/uploads' },
  { path: '/downloads', dir: './data/downloads', headers: { 'Cache-Control': 'no-cache' } },
])
```

```ts
interface AssetMount {
  path: string
  dir: string
  headers?: Record<string, string>
  followSymlinks?: boolean
}
```

path 必须是绝对 URL 前缀；dir 可为绝对路径，相对路径按 Node 运行根目录解析，挂载范围由该 dir 决定；followSymlinks 默认 false。文件路由优先；其后按挂载声明顺序查找，未找到文件时继续后续挂载，全部未命中时继续统一方法判断与 404（包括适用的 HTML 404）。目录挂载的 URL 前缀与文件名区分大小写，不使用文件路由的 caseSensitive 规范化。运行目录是独立请求分支，不从 API 树或页面树借用 _middleware 祖先链；不另建文件挂载作用域系统。需要授权时使用明确的应用中间件，或由下载 API 授权并交付文件流。

storage/local 的 publicUrl 只生成对象公开 URL，不建立挂载；需要开放时，应用显式将对应 dir/path 配置到 defineAssets，见 [storage.md](storage.md)。

运行目录默认 Cache-Control: no-cache，可以显式覆盖。只支持 GET/HEAD，不自动列目录。只有实际存在的文件才向统一方法判断提供 GET/HEAD；与业务路由共享路径时，Allow 合并双方实际支持的方法。不存在文件或越界不贡献方法，由后续路由判断返回适用的 405 或 404。

node 在 Workers 目标报不支持。R2/S3 不自动伪装成本地目录或公开挂载。

## Node 路径与特殊字符

从原始请求 URL 提取路径并只执行一次 URL 解码，将 URL 语义与文件系统路径分开。字面 #、?、% 等文件名通过正常编码访问，不让 URL 解析提前截断文件名，也不进行第二次解码。

拒绝空字节、解码后的点点段和目标根外的路径。挂载根本身允许部署符号链接；根目录尚未创建时保留声明，目录存在后解析并缓存真实根路径。解析最终文件位置，校验其位于实际挂载根内；默认禁止根内子路径经过符号链接，显式允许时仍检查最终目标。规则用于真实请求路径，不以内部构造的非法结构替代外部边界。

## Node 文件响应

大文件按流交付，不整文件读入内存。Content-Type 按文件扩展名，未知类型使用 application/octet-stream。HEAD 保留适用元信息，不开启正文传输。

支持单段 byte Range，满足时返回 206 与 Content-Range；不可满足时返回 416。多段 Range 不构造 multipart 响应，忽略该范围请求并返回完整表示。If-Modified-Since 按修改时间返回适用 304，条件请求与 Range 按 HTTP 优先关系处理；不为已经变化的文件复用旧版本元数据。ETag 按完整的带引号标签比较，保留强、弱比较差异；标签内部的逗号不作列表分隔。

客户端断开取消读取并释放文件句柄。业务授权发生在打开文件交付前，不因命中文件缓存头跳过。

CF 静态响应遵循平台能力，不复刻 Node 文件服务器。平台当前忽略静态资源的 Range 请求并返回完整 200；需要媒体分段读取时选择具有相应能力的存储或媒体服务。[CF 静态资源限制](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

## 验证

检查构建资源与运行目录的策略区别、实际 publicDir、文件路由优先、特殊字符、路径范围校验、条件响应、Range、HEAD 和断开清理。上传助手与对象存储在 storage 的链路验证，不把示例当作测试夹具。
