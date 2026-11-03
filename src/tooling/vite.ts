/**
 * Vite plugin for filesystem route discovery, code generation, and dev serving.
 *
 * @module
 */
import { isBuiltin } from 'node:module'
import { posix, resolve } from 'node:path'

import { getRequestListener } from '@hono/node-server'
import { getPath as getRequestPath } from 'hono/utils/url'
import {
  loadEnv,
  type Manifest,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
} from 'vite'

import { waitUntil } from '../adapter/node/deadline'
import { type ResolvedNodeRuntimeConfig, resolveNodeRuntime } from '../adapter/node/runtime'
import { createNodeStaticHandler } from '../adapter/node/static'
import { getApplicationRoutes } from '../core/context'
import { createApp } from '../core/create'
import type { AppDefinition } from '../core/definition'
import { applicationLifecycles } from '../core/lifecycle'
import { getLogger } from '../core/logging'
import type { AppInstance } from '../core/types'
import type { PageRequestHandler } from '../http/server/types'
import {
  collectDevelopmentAssets,
  createProductionAssets,
  listPublicFiles,
  writeBuildAssets,
} from './build/assets'
import type { DiscoveredPageTree } from './build/discover/pages'
import { generateConfiguredProject, generateResolvedProject } from './build/project'
import {
  type PluginOptions,
  type ResolvedProjectConfig,
  resolvePluginOptions,
  resolveProjectConfig,
} from './config'
export type { PluginOptions } from './config'

/** Resolved engineering configuration exposed to the Sark CLI. */
export interface PluginApi {
  /** Final project paths; available after Vite resolves its configuration. */
  readonly project: ResolvedProjectConfig
  readonly pages: DiscoveredPageTree | undefined
}

/**
 * Integrates API/page discovery, generation, builds, and development serving with Vite.
 * Generates an early Workers entry, then binds final paths and resource URLs in configResolved.
 *
 * @param options - Project entry paths, discovery settings, URL prefixes, and target.
 * @returns A Vite plugin managing generation and development request handling.
 */
export function sark(options: PluginOptions = {}): Plugin & { api: PluginApi } {
  const resolved = resolvePluginOptions(options)
  let project: ResolvedProjectConfig | undefined
  let pages: DiscoveredPageTree | undefined
  let viteConfig: ResolvedConfig
  function getProject(): ResolvedProjectConfig {
    if (!project)
      throw new Error('Sark project paths are unavailable before Vite configuration resolves.')
    return project
  }
  let activeInvalidate: (() => Promise<void>) | undefined
  let handleServerUpdate: ((file: string, isServerModule: boolean) => Promise<void>) | undefined

  return {
    name: '@olivaw/sark',
    enforce: 'pre',

    api: {
      get project() {
        return getProject()
      },
      get pages() {
        return pages
      },
    },

    config(config, { command }) {
      // The official Workers plugin needs the entry before final configuration is available.
      const early =
        resolved.target === 'cloudflare'
          ? resolveProjectConfig(resolve(config.root ?? '.'), resolved)
          : undefined
      const tree = early
        ? generateResolvedProject(early, undefined, undefined, { bootstrap: true })
        : undefined
      return {
        environments: {
          ssr: {
            consumer: 'server',
            // Linked packages must share the Node host's scope and lifecycle registries.
            ...(resolved.target === 'node' && command === 'serve'
              ? { resolve: { external: ['@olivaw/sark'] } }
              : {}),
          },
          ...(early && tree?.pages.length
            ? {
                client: {
                  build: {
                    manifest: true,
                    rolldownOptions: { input: resolve(early.generatedDir, 'client.tsx') },
                  },
                },
              }
            : {}),
        },
      }
    },

    async configResolved(config) {
      viteConfig = config
      project = resolveProjectConfig(config.root, resolved)
      pages = await generateConfiguredProject(config, project)
      if (resolved.target === 'cloudflare' && config.command === 'build' && !pages?.pages.length) {
        writeBuildAssets(
          project,
          createProductionAssets(
            {},
            project,
            pages,
            config.base,
            listPublicFiles(config.publicDir),
          ),
        )
      }
    },

    writeBundle(_options, bundle) {
      if (resolved.target !== 'cloudflare' || this.environment.name !== 'client') return
      const manifestName =
        typeof this.environment.config.build.manifest === 'string'
          ? this.environment.config.build.manifest
          : '.vite/manifest.json'
      const manifest = bundle[manifestName]
      if (!manifest || manifest.type !== 'asset')
        throw new Error('Client build did not emit its manifest.')
      const source =
        typeof manifest.source === 'string'
          ? manifest.source
          : new TextDecoder().decode(manifest.source)
      writeBuildAssets(
        getProject(),
        createProductionAssets(
          JSON.parse(source) as Manifest,
          getProject(),
          pages,
          viteConfig.base,
          listPublicFiles(viteConfig.publicDir),
        ),
      )
    },

    buildApp: {
      order: 'pre',
      async handler(builder) {
        if (resolved.target !== 'cloudflare' || !pages?.pages.length) return
        // The Worker embeds the completed browser mapping. The official plugin
        // still owns Worker builds and moves its emitted assets into client output.
        const client = builder.environments.client
        const build = builder.build.bind(builder)
        const output = await build(client)
        builder.build = (environment) =>
          environment === client && client.isBuilt ? Promise.resolve(output) : build(environment)
      },
    },

    resolveId(id, importer) {
      if (
        this.environment.config.consumer === 'client' &&
        (isBuiltin(id) ||
          id === '@olivaw/sark/server' ||
          id.startsWith('@olivaw/sark/server/') ||
          id.startsWith('@olivaw/sark/db/') ||
          id === '@olivaw/sark/storage' ||
          id.startsWith('@olivaw/sark/storage/') ||
          id === '@olivaw/sark/assets' ||
          id.startsWith('@olivaw/sark/assets/') ||
          id === '@olivaw/sark/visitors' ||
          (id.startsWith('@olivaw/sark/visitors/') && id !== '@olivaw/sark/visitors/browser') ||
          (id.startsWith('@olivaw/sark/auth/') && id !== '@olivaw/sark/auth/webauthn/browser') ||
          id === '@olivaw/sark/middleware' ||
          id === '@olivaw/sark/vite' ||
          (id.startsWith('@olivaw/sark/runtime/') && id !== '@olivaw/sark/runtime/page-browser'))
      )
        this.error(`Browser module "${importer}" cannot import server module "${id}".`)
      if (id === '@vitejs/plugin-react/preamble') {
        // The official React plugin owns refresh when present. Plain JSX builds
        // without that plugin do not install a refresh runtime.
        if (viteConfig.plugins.some((plugin) => plugin.name === 'vite:react-virtual-preamble'))
          return
        return '\0virtual:sark:react-preamble'
      }
    },

    load(id) {
      if (id === '\0virtual:sark:react-preamble') {
        return ''
      }
    },

    transform(_code, id) {
      if (
        this.environment.config.consumer === 'client' &&
        normalizePath(id.split('?')[0]) === normalizePath(getProject().appEntryPath)
      ) {
        this.error('Browser modules cannot import the application configuration entry.')
      }
    },

    async hotUpdate({ file, modules }) {
      if (this.environment.name === 'ssr') {
        await handleServerUpdate?.(file, modules.length > 0)
      }
    },

    async closeBundle() {
      if (activeInvalidate) {
        await activeInvalidate()
      }
    },

    configureServer(server: ViteDevServer) {
      const projectConfig = getProject()
      const nodeEnv =
        resolved.target === 'node'
          ? loadEnv(server.config.mode, server.config.envDir, '')
          : undefined
      let publicPaths = new Set(listPublicFiles(server.config.publicDir))
      function publicHandler() {
        return server.config.publicDir && publicPaths.size
          ? createNodeStaticHandler({
              rootDir: server.config.publicDir,
              assets: {
                base: server.config.base,
                files: Object.fromEntries(
                  [...publicPaths].map((path) => [path, { path, hashed: false }]),
                ),
              },
            })
          : undefined
      }
      let servePublic = publicHandler()
      // Reuse the file responder for exact public filenames, including encoded # and ?.
      // Vite's public middleware uses decodeURI and cannot address those filenames.
      const publicListener = getRequestListener(
        async (request) => (await servePublic?.(request)) ?? new Response(null, { status: 404 }),
      )
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://vite.local').pathname
        if (!pathname.startsWith(server.config.base)) return next()
        let key: string
        try {
          key = decodeURIComponent(pathname.slice(server.config.base.length))
        } catch {
          return next()
        }
        if (!publicPaths.has(key) || !['GET', 'HEAD'].includes(request.method ?? 'GET'))
          return next()
        void publicListener(request, response).catch(next)
      })
      const updatePublicFiles = (file: string) => {
        if (
          server.config.publicDir &&
          normalizePath(file).startsWith(normalizePath(server.config.publicDir) + '/')
        ) {
          publicPaths = new Set(listPublicFiles(server.config.publicDir))
          servePublic = publicHandler()
          developmentAssetsReady = undefined
        }
      }
      server.watcher.on('add', updatePublicFiles).on('unlink', updatePublicFiles)
      let developmentFiles: Readonly<Record<string, unknown>> = {}
      let developmentAssetsReady: Promise<void> | undefined
      const prepareAssets = () =>
        (developmentAssetsReady ??= collectDevelopmentAssets(server, pages, projectConfig)
          .then((assets) => {
            writeBuildAssets(projectConfig, assets)
            developmentFiles = assets.files
            server.environments.ssr.moduleGraph.onFileChange(
              normalizePath(resolve(projectConfig.generatedDir, 'build-assets.ts')),
            )
          })
          .catch((error) => {
            developmentAssetsReady = undefined
            throw error
          }))
      const generatedDir = projectConfig.generatedDir
      const apiPrefix = resolved.apiPrefix
      const apiDir = projectConfig.apiDir === false ? false : normalizePath(projectConfig.apiDir)
      const appEntry = normalizePath(projectConfig.appEntryPath)
      const webDir =
        resolved.webDir === false
          ? false
          : normalizePath(resolve(projectConfig.root, resolved.webDir))

      const isRoutingFile = (file: string) =>
        file === appEntry ||
        Boolean(apiDir && file.startsWith(apiDir + '/')) ||
        Boolean(webDir && file.startsWith(webDir + '/'))
      if (resolved.target === 'cloudflare') {
        server.middlewares.use((request, _response, next) => {
          if (!request.headers.accept?.includes('text/html')) return next()
          void prepareAssets().then(() => next(), next)
        })
        handleServerUpdate = async (file, isServerModule) => {
          if (file.startsWith(normalizePath(generatedDir) + '/')) return
          if (isRoutingFile(file) || isServerModule) {
            pages = await generateConfiguredProject(server.config, projectConfig)
            server.environments.ssr.moduleGraph.onFileChange(
              normalizePath(resolve(generatedDir, 'app.ts')),
            )
            server.environments.ssr.hot.send({ type: 'full-reload' })
          }
          if (isRoutingFile(file) || isServerModule) developmentAssetsReady = undefined
        }
        return
      }

      let currentAppInstance: AppInstance | null = null
      let creatingPromise: Promise<AppInstance> | null = null
      let handoffQueue: Promise<void> = Promise.resolve()
      let fatalDisposalError: Error | null = null
      let shutdown: ResolvedNodeRuntimeConfig['shutdown']
      let activeWsBridge: import('../adapter/node/websocket').NodeWebSocketBridge | undefined
      let closingInstance:
        | { instance: AppInstance; complete: Promise<void>; deadline: number }
        | undefined
      const requests = new Map<
        Parameters<ReturnType<typeof getRequestListener>>[1],
        { instance?: AppInstance; done: Promise<void> }
      >()

      let pageHandlers = new Map<string, PageRequestHandler>()
      let page404: PageRequestHandler | undefined
      let pageUpdateError: unknown

      function updatePageBindings(definition: AppDefinition): void {
        pageHandlers = new Map(
          definition.routes
            .filter((entry) => entry.kind === 'page')
            .map((entry) => [entry.routePath.urlPath, entry.pageHandler]),
        )
        page404 = definition.page404Handler
        pageUpdateError = undefined
      }

      function bindDevelopmentPages(definition: AppDefinition): AppDefinition {
        updatePageBindings(definition)
        return {
          ...definition,
          routes: definition.routes.map((entry) =>
            entry.kind === 'page'
              ? {
                  ...entry,
                  pageHandler: (...args: Parameters<PageRequestHandler>) => {
                    if (pageUpdateError) throw pageUpdateError
                    return pageHandlers.get(entry.routePath.urlPath)!(...args)
                  },
                }
              : entry,
          ),
          page404Handler: definition.page404Handler
            ? (...args: Parameters<PageRequestHandler>) => {
                if (pageUpdateError) throw pageUpdateError
                return page404!(...args)
              }
            : undefined,
        }
      }

      function affectsOnlyPages(file: string): boolean {
        let hasPage = Boolean(webDir && file.startsWith(webDir + '/'))
        const pending = [...(server.environments.ssr.moduleGraph.getModulesByFile(file) ?? [])]
        const seen = new Set<string>()
        const middlewareFiles = new Set(
          [...(pages?.middlewares.values() ?? [])].map((middleware) => middleware.filePath),
        )
        const sharedServer = (path: string) =>
          path === appEntry ||
          Boolean(apiDir && path.startsWith(apiDir + '/')) ||
          middlewareFiles.has(path) ||
          /(?:^|[/.])_middleware\.[jt]s$/.test(path)
        if (sharedServer(file)) return false
        while (pending.length) {
          const module = pending.pop()!
          if (!module.file || seen.has(module.file)) continue
          seen.add(module.file)
          if (module.file.startsWith(normalizePath(generatedDir) + '/')) continue
          if (sharedServer(module.file)) return false
          hasPage ||= Boolean(webDir && module.file.startsWith(webDir + '/'))
          pending.push(...module.importers)
        }
        return hasPage
      }

      async function getAppInstance(): Promise<AppInstance> {
        // Creation must wait for the previous instance handoff to finish.
        await handoffQueue.catch(() => {})

        if (fatalDisposalError) {
          throw new Error(
            `Cannot create application instance: previous instance disposal failed: ${fatalDisposalError.message}`,
            { cause: fatalDisposalError },
          )
        }
        if (closingInstance) {
          throw new Error('Cannot create application instance: previous instance is still closing.')
        }

        if (currentAppInstance) return currentAppInstance
        if (creatingPromise) return creatingPromise

        creatingPromise = (async () => {
          await prepareAssets()
          const appModule = await server.ssrLoadModule(resolve(generatedDir, 'app.ts'))
          const runtime = resolveNodeRuntime(appModule.runtime, nodeEnv)
          const instance = await createApp(bindDevelopmentPages(appModule.definition), {
            env: nodeEnv,
          })
          applicationLifecycles.get(instance)!.configureShutdown(runtime.shutdown)
          try {
            if (instance.definition.routes.some((entry) => entry.routePath.isWs)) {
              const { createNodeWebSocketBridge } = await import('../adapter/node/websocket')
              activeWsBridge = createNodeWebSocketBridge(instance)
            }
          } catch (error) {
            await instance.close()
            throw error
          }
          shutdown = runtime.shutdown
          currentAppInstance = instance
          creatingPromise = null
          return instance
        })().catch((err) => {
          creatingPromise = null
          throw err
        })
        return creatingPromise
      }

      async function closeCurrentInstance(): Promise<void> {
        if (creatingPromise) {
          try {
            await creatingPromise
          } catch {
            /* The pending request receives creation failures. */
          }
        }
        if (!closingInstance) {
          const instance = currentAppInstance
          currentAppInstance = null
          const bridgeToClose = activeWsBridge
          activeWsBridge = undefined
          if (!instance) return
          const lifecycle = applicationLifecycles.get(instance)!
          const deadline = performance.now() + shutdown.deadline
          const owned = [...requests].filter(([, request]) => request.instance === instance)
          const bridgeClosed = bridgeToClose ? bridgeToClose.close(deadline) : Promise.resolve()
          const work = Promise.all([...owned.map(([, request]) => request.done), bridgeClosed])
          const drained = Promise.withResolvers<void>()
          lifecycle.deferDisposalUntil(drained.promise, deadline)
          let cancellation: Error | undefined
          // Attach rejection handling immediately, including while requests are still draining.
          const closed = instance.close().then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          )

          const complete = (async () => {
            if (!(await waitUntil(work, deadline - shutdown.reserve))) {
              cancellation = new Error('Development instance exceeded the request drain budget')
              lifecycle.cancel(cancellation)
              let connections = 0
              for (const [response] of owned) {
                if (!response.destroyed && !response.writableFinished) {
                  connections++
                  response.destroy()
                }
              }
              console.warn('[sark][dev] Cancelling old requests for instance handoff.', {
                connections,
                handlers: lifecycle.pendingRequests,
              })
            }
            // Socket closure alone does not finish a handler awaiting non-cancellable work.
            // Keep this instance's resources until its request and connection work settles.
            await work
            if (bridgeToClose) await bridgeToClose.close(deadline)
            drained.resolve()
            const outcome = await closed
            if (outcome.error !== undefined && outcome.error !== cancellation) throw outcome.error
          })().then(
            () => {
              closingInstance = undefined
            },
            (error: unknown) => {
              fatalDisposalError = error instanceof Error ? error : new Error(String(error))
              closingInstance = undefined
              throw fatalDisposalError
            },
          )
          closingInstance = { instance, complete, deadline }
        }

        const closing = closingInstance
        if (!(await waitUntil(closing.complete, closing.deadline))) {
          throw new Error(
            `Development instance handoff exceeded the shutdown deadline; previous instance is still closing (${applicationLifecycles.get(closing.instance)!.pendingRequests} active handlers).`,
          )
        }
      }

      function enqueueUpdate(update: () => Promise<void>): Promise<void> {
        handoffQueue = handoffQueue.catch(() => {}).then(update)
        return handoffQueue
      }

      function invalidateAppInstance(): Promise<void> {
        return enqueueUpdate(closeCurrentInstance)
      }

      activeInvalidate = invalidateAppInstance

      // Vite invalidates its module graph before hotUpdate; raw watcher events run too early.
      handleServerUpdate = async (file, isServerModule) => {
        if (file.startsWith(normalizePath(generatedDir) + '/')) return
        if (!isRoutingFile(file) && !isServerModule) return
        const pageOnly = affectsOnlyPages(file)
        await enqueueUpdate(async () => {
          try {
            const previousTopology = pageTopology(pages)
            if (isRoutingFile(file) || isServerModule)
              pages = await generateConfiguredProject(server.config, projectConfig)
            developmentAssetsReady = undefined
            server.environments.ssr.moduleGraph.onFileChange(
              normalizePath(resolve(generatedDir, 'app.ts')),
            )
            if (pageOnly && previousTopology === pageTopology(pages)) {
              if (creatingPromise) await creatingPromise
              if (currentAppInstance) {
                await prepareAssets()
                const module = await server.ssrLoadModule(resolve(generatedDir, 'app.ts'))
                updatePageBindings(module.definition)
              }
            } else await closeCurrentInstance()
          } catch (error) {
            if (pageOnly) pageUpdateError = error
            else if (currentAppInstance) {
              try {
                await closeCurrentInstance()
              } catch (cleanupError) {
                console.error(
                  '[sark][dev] Module reload and instance cleanup failed:',
                  new AggregateError([error, cleanupError]),
                )
                return
              }
            }
            console.error('[sark][dev] Module reload failed:', error)
          }
        })
      }

      // Reuse the serialized handoff path when the Vite HTTP server closes.
      server.httpServer?.on('close', () => {
        invalidateAppInstance().catch((err) => {
          console.error('[sark][dev] Error closing application on server close:', err)
        })
      })

      const hmr = server.config.server.hmr
      const hmrPath =
        hmr && typeof hmr === 'object' && hmr.path
          ? posix.join(server.config.base, hmr.path)
          : server.config.base
      const wsProxyRules = Object.entries(server.config.server.proxy ?? {}).flatMap(
        ([key, value]) => {
          const config = typeof value === 'string' ? { target: value } : value
          const target = config.target
          const protocol =
            typeof target === 'string' ? target.split(':')[0] + ':' : target?.protocol
          if (config.ws !== true && protocol !== 'ws:' && protocol !== 'wss:') return []
          return [key.startsWith('^') ? new RegExp(key) : key]
        },
      )
      const onServerUpgrade = async (
        req: import('node:http').IncomingMessage,
        socket: import('node:stream').Duplex,
        head: Buffer,
      ) => {
        try {
          const pathname = new URL(req.url || '/', 'http://localhost').pathname
          const protocol = req.headers['sec-websocket-protocol']
          if (pathname === hmrPath && (protocol === 'vite-hmr' || protocol === 'vite-ping')) return
          if (
            wsProxyRules.some((rule) =>
              typeof rule === 'string' ? pathname.startsWith(rule) : rule.test(pathname),
            )
          )
            return
          await getAppInstance()
          await activeWsBridge?.handleUpgrade(req, socket, head)
        } catch (error) {
          getLogger('dev.websocket').error('WebSocket upgrade failed: {error}', { error })
          socket.destroy(
            error instanceof Error
              ? error
              : new Error('WebSocket upgrade failed', { cause: error }),
          )
        }
      }
      server.httpServer?.on('upgrade', onServerUpgrade)

      const listener = getRequestListener(
        async (request, env) => {
          const app = await getAppInstance()
          requests.get(env.outgoing)!.instance = app
          return app.fetch(request, env)
        },
        {
          errorHandler: (err) => {
            console.error('[sark][dev] Request error:', err)
            return new Response(
              `Dev server error: ${err instanceof Error ? err.message : String(err)}`,
              {
                status: 500,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              },
            )
          },
        },
      )

      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '/').split('?')[0]

        const base = server.config.base
        const resourcePath = pathname.startsWith(base)
          ? '/' + pathname.slice(base.length)
          : pathname
        let publicPath: string
        try {
          publicPath = decodeURIComponent(resourcePath.slice(1))
        } catch {
          return next()
        }
        const isViteResource =
          resourcePath.startsWith('/@') ||
          resourcePath.startsWith('/node_modules/') ||
          Object.hasOwn(developmentFiles, publicPath) ||
          publicPaths.has(publicPath)
        if (isViteResource) return next()
        const isApi = matchesPrefix(pathname, apiPrefix)
        const isHtml = Boolean(req.headers.accept?.includes('text/html'))
        if (!isApi && (resolved.webDir === false || !isHtml)) {
          // Protocol endpoints and runtime mounts may lie outside the API and website prefixes.
          void getAppInstance()
            .then((app) => {
              if (matchesStaticRoute(app, pathname) || matchesAssetMount(app, pathname)) {
                forwardToApplication()
              } else {
                next()
              }
            })
            .catch(next)
          return
        }
        forwardToApplication()

        function forwardToApplication() {
          const done = Promise.withResolvers<void>()
          const delivered = Promise.withResolvers<void>()
          const complete = () => {
            res.off('finish', complete)
            res.off('close', complete)
            delivered.resolve()
          }
          requests.set(res, { done: done.promise })
          res.once('finish', complete)
          res.once('close', complete)
          void Promise.allSettled([listener(req, res).catch(next), delivered.promise]).then(() => {
            requests.delete(res)
            done.resolve()
          })
        }
      })
    },
  }
}

/** Matches assembled static endpoints, including configuration-derived protocol routes. */
function matchesStaticRoute(instance: AppInstance, pathname: string): boolean {
  const normalize = (path: string) => {
    const value = path.replace(/\/$/, '') || '/'
    return instance.config.caseSensitive ? value : value.toLowerCase()
  }
  const path = normalize(getRequestPath(new Request(`http://vite.local${pathname}`)))
  return getApplicationRoutes(instance).some((route) => normalize(route.path) === path)
}

/** Matches declared runtime asset mount URL prefixes for development request forwarding. */
function matchesAssetMount(instance: AppInstance, pathname: string): boolean {
  const definition = instance.definition as AppDefinition | undefined
  const prefixes = definition?.assetMounts?.prefixes
  if (!prefixes || prefixes.length === 0) return false
  return prefixes.some(
    (prefix) => prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/'),
  )
}

function matchesPrefix(path: string, pre: string): boolean {
  if (pre === '/') return true
  const p = path.toLowerCase()
  const pr = pre.toLowerCase()
  return p === pr || p.startsWith(`${pr}/`)
}

function pageTopology(tree: DiscoveredPageTree | undefined): string {
  return JSON.stringify(
    tree?.pages.map((page) => [
      page.routePath.urlPath,
      page.middlewareChain.map((middleware) => middleware.filePath),
    ]),
  )
}
