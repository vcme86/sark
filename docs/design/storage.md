# 应用文件与对象存储

## 职责

文件存储负责应用运行期间的文件写入、读取、元数据查询及删除。构建公开文件归 [assets.md](assets.md)；文件归属、授权、数据库关联和保留政策由应用决定。

独立 Node 小应用可使用本地目录。Workers 使用 R2；Node 多副本优先共享 S3 兼容存储。S3 是广泛采用的对象存储事实接口，不是统一所有厂商能力的正式标准；兼容服务须满足本框架使用的对象操作、条件写入和分片接口。Node 小应用也可以选择对象存储，不根据流量自动切换后端。

## 具名声明

```ts
import { defineStorage } from '@olivaw/sark/storage/local'

export const storage = {
  uploads: defineStorage({ dir: './data/uploads' }),
}
```

每个值是一个后端声明。R2 和 S3 分别从 storage/r2、storage/s3 导入同名 defineStorage，可给导入起别名来声明多个后端。

- local：dir 必填，可为绝对路径；相对路径按 Node 运行根目录解析。可选 publicUrl 表示应用明确开放的访问前缀
- r2：binding 必填，由 env 工厂取得 R2Bucket；可选 publicUrl 表示已配置的公开域名
- s3：bucket、region 必填，endpoint 用于 S3 兼容服务；凭据与 forcePathStyle 沿 SDK 支持配置，可选 publicUrl

dir、bucket、region、binding 及 Sark 声明的必需签名凭据属性可直接接收可能缺失的环境值；所属入口在创建资源前校验，解析结果保证必需值有效。上游原生 SDK 选项保持其原类型，业务单次操作参数也不因此放宽。

本地 dir 由应用选择，Node 运行根目录只作为相对路径的解析基准，不是文件系统沙箱。存储 key 和上传 filename 的边界是应用选定的目标目录；应用负责目录选择与业务授权，不将请求值直接当作目录配置。

公开 URL 不是启用存储就自然存在。local 不自动挂目录，R2/S3 不自动公开 bucket。声明与模块导入不产生 I/O；框架按已选后端创建，借用 binding 或客户端，统一登记自己拥有的资源。

publicUrl 只作为 StoredFile.url 的公开基址，按 key 的各路径段编码后拼接；没有配置时不生成 url。它不创建路由、设置存储权限或证明地址可达。local 需要公开交付时，由应用将同一 dir 和相应 URL 前缀显式声明到 defineAssets。

## 共同服务

选中名称在 ctx.var.storage、instance.storage 和任务上下文中直接可用：

```ts
interface FileStore {
  put(key: string, body: FileBody, options?: PutOptions): Promise<StoredFile>
  get(key: string, options?: GetOptions): Promise<StoredContent | null>
  head(key: string): Promise<StoredFile | null>
  delete(key: string): Promise<void>
}

type FileBody = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>

interface PutOptions {
  contentType?: string
  contentLength?: number
  overwrite?: boolean
  signal?: AbortSignal
}

interface StoredFile {
  key: string
  size: number
  contentType: string
  etag?: string
  lastModified?: Date
  url?: string
}

interface StoredContent extends StoredFile {
  body: ReadableStream<Uint8Array>
}

interface GetOptions {
  range?: { offset: number; length?: number }
  ifMatch?: string
  ifNoneMatch?: string
  signal?: AbortSignal
}
```

key 由服务端选择，原始文件名只作展示资料，不直接决定业务归属。key 不是 URL 或本地绝对路径。缺失 get/head 返回 null；存储故障抛错；删除不存在对象按幂等成功处理。

put 默认 overwrite=false，使用后端真实的条件写入；重名抛出 `code: 'file_exists'` 的错误，不先查询再覆盖。覆盖必须显式选择。FileBody 接收字节数据或流，不要求先将流完整缓冲为 File；声明 contentLength 不能替代对实际接收大小的约束。

读取范围按字节，负数或无效范围拒绝；超出对象的不可满足范围报告 range_not_satisfiable。条件不匹配与对象不存在分开表达，分别保留 precondition_failed、not_modified，应用路由可据此返回 412/304。元数据与版本来自上游，不为不同后端伪造相同的强 ETag。local 使用大小和修改时间生成弱 ETag，可用于 If-None-Match 缓存验证；If-Match 使用强比较，因此不能命中该弱标签，`*` 仍可用于对象存在条件。不为统一标签强度而增加整文件哈希或持久版本号。

业务授权后可以把返回流交给 Hono Response。Sark 的存储服务不自动生成公开下载路由，不绕过应用权限，也不默认给私有对象加共享缓存。

## 各后端实现

本地目录只保存普通文件，不创建元数据旁文件或数据库表。Content-Type 按扩展名推断；显式指定不一致的类型或无法保存的类型参数时报告 unsupported_operation。应用可以将同一目录交给 defineAssets，读取与挂载使用一致的扩展名规则。

本地实现使用 Node 文件系统：检查 key 对应路径在目标根内，先写临时文件，再原子提交且不覆盖已有文件，失败/取消清理临时内容。存储根可为部署符号链接；根内子路径始终拒绝符号链接，不提供 followSymlinks 选项。运行目录交付的可选链接策略由 [assets.md](assets.md) 单独规定。内容读取用流。

R2 普通读写直接复用平台 binding。原生请求/响应正文等带平台长度信息的流可直接传入。普通流需提供 contentLength，由 FixedLengthStream 建立平台认可的精确长度；流上传带 signal 时也必须提供该长度，管道完成、失败和取消均等待传输清理。缺少适配所需长度时报告 unsupported_operation，不全量缓冲，也不用不支持条件完成的 R2 分片上传模拟默认原子写入。R2 binding 不提供通用请求取消参数；signal 用于流传输和调用前检查，不能撤销已经完成的对象提交。

S3 复用 AWS SDK v3 的对象操作、条件请求、流转换与取消。未知长度流使用 @aws-sdk/lib-storage Upload，单并发、有界分片缓冲；条件写入落实到 PutObject 或 CompleteMultipartUpload，不先查询再提交。兼容服务必须在这两个操作中实际执行 `If-None-Match: *` 条件；忽略该条件的服务不满足默认原子不覆盖契约，不能仅凭「S3 兼容」认定可用，也不增加先查后写的降级。已知字节数据、Blob 和已声明长度的流直接使用 PutObject。上传失败清理未完成分片，应用无须自行实现分片协议。

具体 R2 存储类型提供 `readonly native: R2Bucket`，S3 提供 `readonly native: S3Client`，暴露该存储实际使用的绑定/客户端，不额外创建实例。local 不提供虚构 native；共同 FileStore 接口不增加后端联合。具名声明保留各自的具体服务类型，应用可显式使用上游高级操作，框架不翻译 SDK 的所有选项。

后端不支持某个选中操作时明确报告 unsupported_operation，不用先查后写模拟原子条件。不启用对象存储的应用不加载 AWS SDK。

## 预签名直传与读取

较大文件可由应用 API 授权后签发短期上传 URL，浏览器直接传到对象存储，避免所有字节经过应用实例。小文件也可以走应用 API 流式写入。

storage/presign 导出 `definePresign<Options extends PresignConfig>(options: Options): PresignDeclaration<Options>`，返回声明保留选项类型，作为所选对象存储配置的 presign 字段，不包装整个声明，也不增加顶层插件或配置导出名：

```ts
import { definePresign } from '@olivaw/sark/storage/presign'
import { defineStorage } from '@olivaw/sark/storage/s3'

export const storage = {
  uploads: defineStorage({
    bucket: 'example-uploads',
    region: 'us-east-1',
    presign: definePresign({ expiresIn: 300 }),
  }),
}
```

PresignConfig 按所属后端区分：

```ts
interface S3PresignConfig {
  expiresIn?: number
  endpoint?: never
  region?: never
  bucket?: never
  credentials?: never
}

interface R2PresignConfig {
  expiresIn?: number
  endpoint: string | undefined
  region?: string
  bucket: string | undefined
  credentials: {
    accessKeyId: string | undefined
    secretAccessKey: string | undefined
    sessionToken?: string
  }
}

type PresignConfig = S3PresignConfig | R2PresignConfig
```

S3 的 presign 只接受 S3PresignConfig，从所属存储复用客户端、bucket、endpoint、region 和凭据，不允许重复配置或覆盖签名目标。R2 的 presign 只接受 R2PresignConfig，额外提供与所属 binding 对应的 S3 endpoint、bucket 和凭据，region 默认 auto；这些信息不能从 R2Bucket 取得。类型检查覆盖通过变量传入的声明；缺少必需值、后端不符或提供不适用字段时，在资源创建前报配置错误，不静默忽略。

Node 的 S3 预签名使用 `@aws-sdk/s3-request-presigner` 的 getSignedUrl，复用所属 S3Client。Workers 的 R2 预签名使用同一官方包的 S3RequestPresigner，SHA-256 使用 @aws-sdk/checksums/sha 的平台实现（Workers 使用 Web Crypto），不创建 S3Client，不自行实现 SigV4；普通读写继续使用原 R2 binding。两条实现按目标和后端生成独立导入，不因 Workers 启用预签名而放开 storage/s3 的 Node 限制。[AWS SDK 预签名](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/)、[R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

expiresIn 默认 300 秒，只接受 1 至 604800 的整数秒。签发时省略使用该值，可显式使用不超过配置期限的更短值，并遵守上游实际支持的期限。definePresign 只保存声明及延迟初始化引用，签名 SDK 仅在启用时接入；local 不支持此能力。配置类型与校验不引用签名执行模块，普通 R2 的构建模块图不包含 AWS/Smithy；不依赖摇树优化删除未选能力。

依赖按选中能力安装：Node S3 需要 @aws-sdk/client-s3 与 @aws-sdk/lib-storage；预签名需要 @aws-sdk/s3-request-presigner，R2 预签名另需 @aws-sdk/checksums。框架将这些包声明为可选 peerDependencies，开发测试作为 devDependencies 安装；未选能力的应用不要求安装。

启用后该存储增加 `presign({ operation: 'put' | 'get', key, expiresIn?, contentType? })`，返回 url、method、必须携带的 headers 和 expiresAt（签名声明的过期时间，Unix 秒；凭据过期或撤销可使其提前失效）。未启用时不提供该方法。

R2 binding 本身没有 S3 预签名能力。选择 R2 浏览器直传时，除上述签名配置外还须设置 bucket CORS；普通 binding 读写不增加这些要求。[R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

对象键、操作和有效期由服务端授权后确定。预签名 URL 在期限内可能重复使用，不能把它当成一次性业务提交，也不能保证所有大小/内容约束都已由签名强制执行。需要传输前硬限额时使用能执行该限制的接收路径。

上传后应用调用 head 核对实际对象、大小、类型及业务约定，再登记关联。客户端自报成功、URL 签发成功都不是业务完成。Content-Type 不是内容真实性证明；内容检查按应用用途处理。

## Node 本地上传助手

storage/local 同时导出 saveUploadFile，委托同一套本地写入逻辑：

```ts
interface SaveUploadOptions {
  dir: string
  filename?: string
  maxSizeBytes?: number
  signal?: AbortSignal
}

interface SavedUploadFile {
  path: string
  name: string
  size: number
}

function saveUploadFile(file: File, options: SaveUploadOptions): Promise<SavedUploadFile>
```

dir 接受绝对路径；相对路径按运行根目录解析。结果 path 相对运行根返回，目标在其外时可包含 `..`，仍可用于定位保存后的文件。filename 省略采用上传名，但仍校验单个合法文件名，不允许路径分隔、空字节、点段或逃出目标目录。重名原子失败抛出 `code: 'file_exists'` 的错误，与 FileStore.put 一致；超过 maxSizeBytes 或取消均清理临时文件，不留半成品。

框架存储错误通过小写 code 分类，原始后端错误通过 cause 保留。文件冲突如何映射为 HTTP 状态由应用决定，存储服务不自行返回 HTTP 响应。

这个助手适合应用明确选择的本地 File 上传，不能作为 CF 或多实例的默认持久化策略。server 总入口不转导出它。

## 生命周期与边界

Node 长期客户端归资源所有者；读写流的结束与取消由所属工作管理。Workers 不在本地临时目录保存长期文件，不在请求返回时释放仍被连接回调使用的 binding。

文件与业务数据库不是一个事务。应用负责失败补偿、文件登记和删除策略，框架不承诺对象写入与文章记录原子提交。验证覆盖实际后端的读写/删除、条件请求、流式读取、取消、不覆盖提交及直传确认链路。

另验 presign 的后端配置约束、默认/较短期限与实际签名请求。S3 重复签名配置、R2 缺必需配置及 local 启用预签名均被拒绝；Node 验证 S3Client 复用，Workers 在 workerd 中验证 R2 GET/PUT 签名及 Content-Type 约束，未启用时没有方法或签名依赖。native 保留真实后端类型且不重复创建客户端；另验 publicUrl 的逐段编码，以及 FileStore/saveUploadFile 的 file_exists 分类一致。
