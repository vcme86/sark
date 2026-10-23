# 日志与请求关联

## 基础模式与完整配置

无 logging 声明时，保留 info 级控制台基本诊断、getLogger 和请求 ID 关联。不会每个请求生成一条完整访问记录，不创建文件输出/刷新计时器。

完整配置独立声明，仍使用同一套 LogTape：

```ts
import { getFileSink } from '@logtape/file'
import { getConsoleSink } from '@logtape/logtape'
import { defineLogging } from '@olivaw/sark/logging'

export const logging = defineLogging({
  sinks: {
    console: () => getConsoleSink(),
    file: () => getFileSink('./logs/access.log'),
  },
  access: ['file'],
  categories: { app: ['console'] },
})
```

本例为 Node：访问日志只写 file，业务 app 类别写 console。配置中不出现 Sark 内部类别名，access 直接使用输出目标名称数组。

## 配置契约

level 默认 info。启用 logging 后 access 默认 true，表示默认 console；false 或空数组关闭访问记录；字符串数组只写列出的输出，不额外继承 console。categories 只路由应用自己的类别。

sinks 是名称到创建函数的映射，不是已打开的实例。装配在资源阶段调用函数并登记释放；直接在模块顶层 getFileSink 会提前打开资源，不符合声明约定。

框架内置名为 console 的默认 sink。sinks 中显式提供同名 console 时替换它；只提供 file 等其他名称不会删除内置 console。access=true 使用这个有效 console，显式访问目标数组与 categories 中引用的未知名称仍报错，不静默回退。

显式输出列表通过 LogTape 的 `parentSinks: 'override'` 配置替代父级输出，避免重复。引用不存在的 sink 名称时，在创建前报错。

redact 默认包含 authorization、cookie、set-cookie、password、token、secret。框架不默认记录请求/响应正文；业务显式日志也须按数据含义处理，字段名脱敏不是任意敏感正文的保证。

## 关联与时机

管线首先产生 requestId，写 ctx.var.requestId 并返回 X-Request-Id。仅受信代理来源可沿用入站 ID，其余重新生成。

请求、内部调用和返回链上的异步工作继承同一执行作用域。WS 在握手建关联，回调沿连接上下文；任务以 job/name 建作用域，不借用最近请求。

getLogger(category) 从 server 导入，绑定当前应用/工作；日志格式化、类别和 sink 复用 LogTape，不自行实现日志引擎。

访问记录每个外部 HTTP 请求一条，含方法、路径、状态、请求 ID、客户端 IP、结果和耗时。流式响应按正文结束/取消计时；内部 API 调用不重复计为外部访问。

## 平台与生命周期

Node 可以使用 console 或独立 file sink；CF 默认 console 交平台收集，不配置虚假持久目录。远程 sink 是应用明确选择的 LogTape 接入，不默认建设日志聚合服务。

日志配置由宿主统一管理，应用只拥有自己创建的输出。多个实例或外部宿主已有配置时，不静默 reset/dispose 不属于当前实例的设施；配置冲突应在创建前诊断。普通单应用和串行 HMR 沿同一创建/释放链。

启动失败也用基础诊断记录。排空日志继续写入；释放时等待实际工作，最后 flush 并逆序 dispose 所拥有 sink。超时按应用剩余预算，不为日志重新开完整等待期限。

## 验证

检查未声明的基础模式、显式目标替代继承、sink 只在创建阶段分配、失败回滚/释放、流结束访问时机，以及并发请求/内部调用/WS/任务的关联隔离。关闭完整访问日志不应关闭基本错误诊断。
