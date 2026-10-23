# 静态文件与运行目录

## 构建文件与运行目录

构建静态文件包括 Vite 生成的内容哈希资源及 publicDir 中的文件，默认公开。它们不经过业务认证、CSRF、限流和业务中间件；保留适用的安全头、CORS 与平台压缩。

运行目录是 Node 应用显式开放的文件挂载，执行应用级请求策略和全局中间件，应用可在其中授权。应用运行文件的存储接口和上传流程见 [storage.md](storage.md)。将文件放进 publicDir 等于公开交付，不能用它保护私有文件。

## 构建文件

publicDir 以 Vite 解析值为准，默认 public，可以修改或关闭。框架不另建 static/statics 约定。具体资源布局由 [build.md](build.md) 定义。

构建文件的默认响应策略：

- Vite 生成、内容哈希包含在 URL 中的产物使用 `Cache-Control: public, max-age=31536000, immutable`
- publicDir 中未哈希的文件及 HTML 使用 `Cache-Control: no-cache`，允许保存，但每次复用前必须验证；支持时通过 ETag/Last-Modified 条件请求返回 304
- 开发环境不发送上述长期缓存策略

内容哈希产物依据 Vite 构建清单识别，不按文件名外观猜测。未哈希文件不设一段允许直接复用旧内容的默认时间，避免同 URL 更新后继续使用旧版本。no-cache 的验证语义见 [RFC 9111 §5.2.2.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.4)。本节只规定构建文件，不覆盖动态 SSR 页面的 cache 策略。

生产资源 URL 由 manifest 与宿主接入生成，不手写哈希路径。Node 静态文件处理与 Workers 的 ASSETS 响应接入均应用上述默认头，并保留适用的条件响应及验证器；平台内部缓存仍由平台管理。

Node 读取构建输出；Workers 复用平台静态资源 binding，不读取本地构建文件目录，也不自动配置 SPA fallback 代替 SSR。

## Node 运行目录声明

```ts
import { defineAssets } from '@olivaw/sark/assets/node'

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

path 必须是绝对 URL 前缀，dir 相对 Node 运行根目录；followSymlinks 默认 false。挂载按声明顺序匹配，文件路由优先。运行目录是独立请求分支，不从 API 树或页面树借用 _middleware 祖先链；不另建文件挂载作用域系统。需要授权时使用明确的应用中间件，或由下载 API 授权并交付文件流。

storage/local 的 publicUrl 只生成对象公开 URL，不建立挂载；需要开放时，应用显式将对应 dir/path 配置到 defineAssets，见 [storage.md](storage.md)。

运行目录默认 Cache-Control: no-cache，可以显式覆盖。只支持 GET/HEAD，不自动列目录；不存在文件和越界都返回 404。

assets/node 在 Workers 目标报不支持。R2/S3 不自动伪装成本地目录或公开挂载。

## 路径与特殊字符

从原始请求 URL 提取路径并只执行一次 URL 解码，将 URL 语义与文件系统路径分开。字面 #、?、% 等文件名通过正常编码访问，不让 URL 解析提前截断文件名，也不进行第二次解码。

拒绝空字节、解码后的点点段和目标根外的路径。解析最终文件位置，校验其位于实际挂载根内；默认不跟随符号链接，显式允许时仍检查最终目标。规则用于真实请求路径，不以内部构造的非法结构替代外部边界。

## 文件响应

大文件按流交付，不整文件读入内存。Content-Type 按文件扩展名，未知类型使用 application/octet-stream。HEAD 保留适用元信息，不开启正文传输。

支持单段 byte Range，满足时返回 206 与 Content-Range；不可满足时返回 416。多段 Range 不构造 multipart 响应，忽略该范围请求并返回完整表示。If-Modified-Since 按修改时间返回适用 304，条件请求与 Range 按 HTTP 优先关系处理；不为已经变化的文件复用旧版本元数据。

客户端断开取消读取并释放文件句柄。业务授权发生在打开文件交付前，不因命中文件缓存头跳过。

## 验证

检查构建资源与运行目录的策略区别、实际 publicDir、文件路由优先、特殊字符、路径范围校验、条件响应、Range、HEAD 和断开清理。上传助手与对象存储在 storage 的链路验证，不把示例当作测试夹具。
