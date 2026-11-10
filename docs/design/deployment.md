# 部署与运行场景

## 支持范围

主要场景是 Node 独立小应用：页面/API 同应用，需要时选择 SQLite 与本地文件。Workers 小应用使用 D1/R2 和平台调度。Node 负载增长优先复制完整应用，共用 PostgreSQL/对象存储。页面/API 分离是可选组合，优先同源入口按路径转发。

页面/API 一体部署时，SSR 始终访问本实例 API，不为 CF 或多副本支持增加网络回环。框架不内建任意混合拓扑、跨地域多活、微服务治理或分布式数据库。

## Node 运行与环境

运行基准 Node.js 26，目标 Linux amd64/arm64。标准生产入口先加载环境，再解析 runtime：port 优先使用显式配置，其次 PORT，默认 3000；hostname 可显式指定，省略时沿 Node listen 绑定所有网络接口。端口范围、监听失败与开发环境的区别由 [application.md](application.md) 统一定义。资源需求按页面、连接、缓存与任务的实际使用测量。

产物由 [build.md](build.md) 唯一定义；标准为 dist/server.mjs，直接 node 执行与 sark start 等价。运行不需要 Vite 或原始业务源码，外置依赖/驱动仍须安装。

标准入口在导入应用配置前加载环境。Node 文件从低到高为 .env、.env.local、.env.[mode]、.env.[mode].local，已有进程变量最高；生产从应用运行根加载，默认 production，不引用构建机器目录。开发/构建沿 Vite 的 envDir/mode。

各能力只使用传入的 Env。DATABASE_URL、JWT/访客/因素密钥由应用工厂明确赋值；不自动把 COOKIE_SECRET/HOSTS 等变量变成另一套核心配置来源。

Node 部署在可信反向代理后时，代理须移除或覆写客户端提供的 X-Forwarded-For、X-Forwarded-Host、X-Forwarded-Proto 等转发头。trustedProxies 允许采信代理提供的来源信息，不代替这项代理配置；请求 Host 约束与对外转发主机也不混用。

Node 开发入口将 Vite 加载结果作为该实例的 Env，不把文件值写入 process.env。Vite 重启后重新取得环境，已有进程变量仍最高优先，不让上次文件值污染本次解析。

浏览器沿 Vite 的 envPrefix 公开变量，值在构建时确定；服务端秘密不进入浏览器。替换运行秘密不要求重建浏览器，修改运行时变量也不会改变已打包的公开常量。

## SQLite 与本地文件

数据库和上传目录放持久卷，配置与进程工作目录一致，准备权限与备份。不能把数据只写进可重建容器层。多个机器不要通过网络文件系统打开同一 SQLite 文件；SQLite/D1 不是本框架的分布式数据库。

本地上传是明确选择，不成为 Workers 或多副本的默认方式。较大文件可以经授权预签名直传到对象存储，见 [storage.md](storage.md)。

动态订阅执行所属端点的原生内容回调，发布地址与文档内链接由应用分别配置，内容范围由应用控制，见 [feeds.md](feeds.md)。动态请求及数据库查询计入对应平台用量，缓存头不等于静态交付；固定文件可使用 publicDir。

## Node 容器示例

以下模板从空项目构建，PNPM_VERSION 由应用锁定的精确版本作为构建参数提供。包含原生驱动编译工具；不需要原生模块的应用可省去该安装步骤。

```dockerfile
FROM node:26-bookworm-slim AS deps
ARG PNPM_VERSION
WORKDIR /app
RUN test -n "$PNPM_VERSION" && npm install -g "pnpm@$PNPM_VERSION"
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM deps AS prod-deps
RUN pnpm prune --prod

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
```

pnpm 版本和允许原生依赖执行的构建策略放在应用工程中，不能假定所有 Node ABI/架构都有预编译包。原生编译发生在同一目标平台和 ABI，运行镜像不携带 devDependencies/编译工具。

Node 25 起不再内置 Corepack，模板显式安装选定 pnpm。镜像不包含真实密钥；持久卷权限、运行依赖和构建配置按应用实际选择验证。模板不承诺无论选用何种外部 SDK 都能省去其运行依赖。

## 反向代理与来源

Node 默认 trustedProxies 为 loopback/private，适合同机代理和受控容器网络。公网直连以 socket 对端为准，不能信任客户端自带转发头。入口把公开协议/主机/端口与客户端地址正确交给应用。

```nginx
location / {
  proxy_pass http://app:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Port $server_port;
  proxy_buffering off;
  proxy_read_timeout 3600s;
}
```

本例覆盖转发链；正确追加配合从右向左可信链遍历也可用。实际连接对端为起点，跳过可信代理，在第一个不可信地址停止，不能直接采信最左侧地址。

直接服务不可信内网客户端或入口 SNAT 改变信任前提时，收紧网段或 trustedProxies=[]。流式 SSR/SSE 需要入口不缓冲，超时按业务决定；WS 另按代理自身规则转发升级。

## Node 探针与停机

默认 /livez、/readyz；路径/关闭由 runtime 配置，health 添加依赖检查。编排器配置必须与实际端点一致：

```yaml
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: app
      image: example/app:latest
      ports:
        - containerPort: 3000
      livenessProbe:
        httpGet: { path: /livez, port: 3000 }
        periodSeconds: 10
      readinessProbe:
        httpGet: { path: /readyz, port: 3000 }
        periodSeconds: 5
        failureThreshold: 2
```

SIGTERM/SIGINT 进入 draining，readiness 立即 503，停止新业务和触发，在默认 10 秒总预算内排空/释放。正常退出 0；第二次终止信号强制退出 1。预算耗尽会中断传输、取消在途工作并报告关闭失败；取消依赖业务回调配合，不能终止 JavaScript Promise，也不保证超出预算的 onClose 或业务清理完成。手动 close 拒绝时资源可能已按强制停机流程释放，应用不得继续把该实例用于业务。编排宽限期大于应用总预算，流量摘除和业务幂等仍需部署配合。

不把依赖故障放入 liveness 导致重启正常进程。探针默认由部署层限制来源，metrics 同理；需要时使用独立准入。

这些网络限制需要部署实际配置，框架不自动生成防火墙或代理规则。监听公网且未限制来源、未设置独立 auth 时，基础探针及已启用的指标端点可被公网访问。

## Workers 配置与交付

复用官方 Cloudflare Vite 插件，workerd 开发/预览和生成 Wrangler 配置是实际运行依据。

```jsonc
{
  "name": "example",
  "main": "./.build/worker.ts",
  "compatibility_date": "2026-10-01",
  "assets": { "html_handling": "none" },
  "d1_databases": [{ "binding": "DB", "database_name": "example", "database_id": "<database-id>" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "example-files" }],
  "triggers": { "crons": ["0 3 * * *"] },
}
```

这是同时使用页面/DB/文件/任务的示例，未选能力删除相应 binding。日期由应用锁定并在目标验证；AsyncLocalStorage 按对应日期的支持和必要标记处理，不机械添加整个 Node 兼容层。

静态构建文件使用平台默认的静态资源优先路由，匹配文件时直接交付，未匹配时进入 Worker 处理 SSR 页面与 API；不把 API 404 重写成 SPA index.html。官方 Vite 插件负责 client 输出目录和部署配置，无须手写 assets.directory，也不必声明框架不使用的 ASSETS binding。

静态直接交付不占用用户 Worker 调用额度；动态请求仍按平台规则计费。框架不为了应用日志、请求 ID 或动态头把静态请求送入 Worker。静态响应策略使用原生 `_headers`，规则与覆盖方式见 [assets.md](assets.md)。[Worker 路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)、[静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

设置 `run_worker_first: true`，或让资源路径命中 Worker-first 模式，会调用用户 Worker 并占用其额度；静态路径的否定模式保留平台直接交付。

Vite base 非根路径时，原生 assets.base_path 使用同一公开前缀。例如资源位于 `/resources/`、页面和 API 位于该前缀之外：

```jsonc
{
  "assets": {
    "base_path": "/resources",
    "run_worker_first": ["/*", "!/resources/*"],
    "html_handling": "none",
  },
}
```

该原生分流让资源路径直接进入静态服务，其余路径进入 Worker，也避免 Vite 开发服务器把前缀外的动态请求当作资源 base 错误。资源前缀用于公开文件，不与动态路由共占；根 base 沿默认静态优先规则，无须全量 Worker-first。base_path 与 Vite base 可在 Vite 配置中使用同一常量，通过官方插件的 config 选项交付，不增加另一套 Sark 平台配置或修改官方插件内部状态。[原生子路径挂载](https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/)

`html_handling: "none"` 保留 publicDir 中 HTML 文件的原始 URL，避免平台去除 `.html` 后跳转到未注册的页面路径。

bindings 来自当前 env，secrets 经平台配置，本地沿官方 .dev.vars/.env 规则。Cron 实际周期只有 Wrangler 来源；onCron 只是处理映射。Node 文件日志、监听、固定延迟调度和进程探针不装入 CF。

部署使用构建生成的有效 Wrangler 配置，D1 迁移在部署流程中执行，启动时不执行 DDL。普通 R2 binding 不需要 S3 密钥；只有预签名直传另配凭据/CORS。[Cloudflare Vite 插件](https://developers.cloudflare.com/workers/vite-plugin/)

## Node 多副本

每个副本保留完整页面/API，SSR 继续内部调用。共享 PostgreSQL、对象存储和需要跨实例继续执行的认证流程状态；池总量按全部副本预算。

例如 A 副本建立 MFA 挑战、后续请求落到 B，只有 A 内存中的状态无法让 B 完成流程，因此此时显式选择 PG 等满足契约的共享状态。Node 单实例继续使用默认内存，不要求额外确认配置；框架不能可靠探测副本数，也不假装自动修正部署拓扑。

页面 LRU、请求 dedup、认证钩子缓存和 Node 限流各有自己的实例范围，不一律搬远端。缓存失效不广播，入口限流不变成集群配额；需要更严格结果时选择相应应用方案。

周期任务优先独立运行单元，Web 副本不重复启用；不自动选主。WS 保持已建立连接，重连重新认证，跨副本广播由应用明确选择。滚动更新遵守就绪和排空，共享密钥轮换保证旧凭据的验证窗口。

应用副本扩容不自动使入口、数据库或对象存储高可用，也不解决慢 SQL；先按真实瓶颈评估 CDN、缓存、查询和任务安排。

## 页面/API 分离

默认推荐同源入口路径转发。页面服务配置受信 serverUrl/browserUrl，类型独立交付，身份展示由应用映射；API 按真实网络验证，服务端向受信 API 传递 Cookie/Bearer，并在页面响应头提交前合并 API 返回的 Cookie。

真正跨站时处理 CORS、credentials、Cookie 域/Path/SameSite、WebAuthn RP/origin。页面服务不必持有 API DB 和签名密钥；框架不为分离部署自动增加纯 CSR/SSG 或通用 RPC。

## 验证

验证 Node 独立应用的持久数据/重启、CF D1/R2/Scheduled、Node PG/对象存储多副本、页面/API 分离这四类已选链路。使用标准构建、预览与测试命令，区分平台/SDK 依据和实际部署结果，不用一种环境的绿色测试代替其他目标。
