# Sark 文档

## 设计文档

设计文档位于 `design/`，供框架开发、审查和维护使用。建议先阅读整体架构，了解职责划分与依赖方向，再按任务查阅专项设计。

### 整体与工程

- [architecture.md · 整体架构](design/architecture.md)：项目定位、模块职责、依赖方向与公开入口
- [configuration.md · 配置解析、合并与传递](design/configuration.md)：统一配置机制、生命周期、下游契约及新能力接入
- [application.md · 应用声明、装配与运行](design/application.md)：配置、环境、实例创建、请求管线与生命周期
- [build.md · 构建、发现与生成](design/build.md)：文件发现、代码生成、Vite 接入与平台构建
- [deployment.md · 部署与运行场景](design/deployment.md)：Node、Workers、多副本及页面与 API 分离部署

### HTTP 与页面

- [http.md · HTTP 接口与客户端](design/http.md)：文件路由、输入输出、类型安全客户端、中间件与 SSE
- [websocket.md · WebSocket](design/websocket.md)：连接声明、握手、事件、资源释放与平台接入
- [pages.md · 页面、交互与导航](design/pages.md)：页面路由、Loader、Action、元数据与导航行为
- [rendering.md · 渲染、水合与 API 传输](design/rendering.md)：SSR、水合、首屏资源及一体与分离部署的 API 调用
- [assets.md · 静态文件与运行目录](design/assets.md)：构建资源交付、Node 目录挂载、路径与文件响应
- [page-cache.md · 公共页面缓存](design/page-cache.md)：缓存条件、缓存键、并发填充、失效与实例范围
- [rate-limit.md · 入口限流](design/rate-limit.md)：策略声明、覆盖规则、响应头与平台差异

### 数据与应用服务

- [database.md · 数据库与持久化](design/database.md)：SQLite、PostgreSQL、D1、Drizzle 类型与资源生命周期
- [storage.md · 应用文件与对象存储](design/storage.md)：本地文件、R2、S3、预签名访问与上传助手
- [jobs.md · 后台任务与调度](design/jobs.md)：Node 调度、Workers Scheduled、执行、取消与排空
- [visitors.md · 游客身份](design/visitors.md)：Cookie 标识、按需创建与浏览器初始化
- [stats.md · 具名计数与主体去重](design/stats.md)：计数、主体识别、去重与存取契约

### 认证与会话

- [auth.md · 第一方认证与会话](design/auth.md)：身份、凭据验证、会话签发、续期与失效
- [oauth.md · 第三方登录](design/oauth.md)：OAuth 2.0、OIDC、登录事务与账户映射
- [mfa.md · 多因素认证、挑战与恢复](design/mfa.md)：共同认证流程、短期状态、再次认证与恢复码
- [totp.md · TOTP 认证因素](design/totp.md)：因素管理、验证、防重放、密钥加密与存取
- [webauthn.md · WebAuthn 与 Passkey](design/webauthn.md)：注册、认证、无密码登录与凭据存取

### 日志、指标与健康检查

- [logging.md · 日志与请求关联](design/logging.md)：基础日志、访问日志、输出配置与请求关联
- [metrics.md · Node 运行与应用指标](design/metrics.md)：指标采集、Registry 生命周期与 Prometheus 导出
- [health.md · Node 探针与依赖检查](design/health.md)：基础探针、依赖检查与访问控制
