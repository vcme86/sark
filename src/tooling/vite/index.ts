/**
 * Vite plugin for filesystem route discovery, code generation, and dev serving.
 *
 * @module
 */

import { resolve } from 'node:path'

import { getRequestListener } from '@hono/node-server'
import { normalizePath, type Plugin, type ViteDevServer } from 'vite'

import { createApp } from '../../core/create'
import type { AppInstance } from '../../core/types'
import { discoverAppEntry } from '../build/discover/app'
import { discoverApiRoutes } from '../build/discover/routes'
import { generateBuildArtifacts } from '../build/generate'
import {
  type ResolvedProjectConfig,
  type ResolvedSarkOptions,
  resolveProjectConfig,
  resolveSarkOptions,
  type SarkOptions,
} from '../config'
export type { SarkOptions } from '../config'

/** Resolved engineering configuration exposed to the Sark CLI. */
export interface SarkPluginApi {
  readonly options: ResolvedSarkOptions
  /** Final project paths; available after Vite resolves its configuration. */
  readonly project: ResolvedProjectConfig
}

/**
 * Discovers app exports and API routes when Vite resolves configuration.
 *
 * @param options - Project entry paths, discovery settings, generation directory, and target.
 * @returns A Vite plugin managing generation and development request handling.
 */
export function sark(options: SarkOptions = {}): Plugin & { api: SarkPluginApi } {
  const resolved = resolveSarkOptions(options)
  let project: ResolvedProjectConfig | undefined
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
      options: resolved,
      get project() {
        return getProject()
      },
    },

    configResolved(config) {
      project = resolveProjectConfig(config.root, resolved)
      generateResolvedProject(project)
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

      let currentAppInstance: AppInstance | null = null
      let creatingPromise: Promise<AppInstance> | null = null
      let handoffQueue: Promise<void> = Promise.resolve()
      let fatalDisposalError: Error | null = null

      const generatedDir = projectConfig.generatedDir
      const apiPrefix = resolved.apiPrefix
      const apiDir = projectConfig.apiDir === false ? false : normalizePath(projectConfig.apiDir)
      const appEntry = normalizePath(projectConfig.appEntryPath)

      async function getAppInstance(): Promise<AppInstance> {
        // Wait for any ongoing instance invalidation / disposal to settle
        await handoffQueue.catch(() => {})

        if (fatalDisposalError) {
          throw new Error(
            `Cannot create application instance: previous instance disposal failed: ${fatalDisposalError.message}`,
            { cause: fatalDisposalError },
          )
        }

        if (currentAppInstance) return currentAppInstance
        if (creatingPromise) return creatingPromise

        creatingPromise = (async () => {
          const appFilePath = resolve(generatedDir, 'app.ts')
          const appModule = await server.ssrLoadModule(appFilePath)
          const instance = await createApp(appModule.definition, { env: process.env })
          currentAppInstance = instance
          creatingPromise = null
          return instance
        })().catch((err) => {
          creatingPromise = null
          throw err
        })
        return creatingPromise
      }

      async function invalidateAppInstance(): Promise<void> {
        const previousHandoff = handoffQueue
        handoffQueue = (async () => {
          await previousHandoff.catch(() => {})

          // If an instance is being created concurrently, wait for it to settle so it can be disposed
          if (creatingPromise) {
            try {
              const pending = await creatingPromise
              await pending.close()
            } catch {
              // Creation errors reach waiting requests; disposal errors are recorded below.
            } finally {
              creatingPromise = null
            }
          }

          if (currentAppInstance) {
            const inst = currentAppInstance
            currentAppInstance = null
            try {
              await inst.close()
            } catch (err) {
              fatalDisposalError = err instanceof Error ? err : new Error(String(err))
              throw err
            }
          }
        })()
        await handoffQueue
      }

      activeInvalidate = invalidateAppInstance

      // Vite invalidates its module graph before hotUpdate; raw watcher events run too early.
      handleServerUpdate = async (file, isServerModule) => {
        try {
          const isRoutingFile =
            file === appEntry || Boolean(apiDir && file.startsWith(`${apiDir}/`))

          if (isRoutingFile || isServerModule) {
            if (isRoutingFile) {
              generateResolvedProject(projectConfig)
              // New or removed routes change generated imports independently of the source module.
              server.environments.ssr.moduleGraph.onFileChange(
                normalizePath(resolve(generatedDir, 'app.ts')),
              )
            }
            await invalidateAppInstance()
          }
        } catch (err) {
          console.error('[sark][dev] Module reload failed:', err)
        }
      }

      // Clean shutdown when Vite dev server closes
      server.httpServer?.on('close', () => {
        invalidateAppInstance().catch((err) => {
          console.error('[sark][dev] Error closing application on server close:', err)
        })
      })

      const listener = getRequestListener(
        async (request, env) => {
          const app = await getAppInstance()
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
        const url = req.url ?? '/'
        const pathname = url.split('?')[0]

        // Only handle requests matching apiPrefix (case-insensitive for dev dispatch)
        if (!matchesPrefix(pathname, apiPrefix)) {
          return next()
        }

        listener(req, res).catch(next)
      })
    },
  }
}

function matchesPrefix(path: string, pre: string): boolean {
  if (pre === '/') return true
  const p = path.toLowerCase()
  const pr = pre.toLowerCase()
  return p === pr || p.startsWith(`${pr}/`)
}

/**
 * Runs discovery and code generation for the Vite plugin and CLI.
 *
 * @param projectRoot - Resolved Vite project root used to resolve all relative option paths.
 * @param options - Sark discovery and generation settings; omitted values use shared defaults.
 * @throws If discovery detects invalid exports or route conflicts, or generated files cannot be written.
 */
export function generateProject(projectRoot: string, options: SarkOptions = {}): void {
  generateResolvedProject(resolveProjectConfig(projectRoot, resolveSarkOptions(options)))
}

/**
 * Generates artifacts using the owning entry's complete project configuration.
 *
 * @param config - Resolved options and absolute discovery paths.
 * @throws If discovery detects conflicts or generation cannot write its artifacts.
 */
export function generateResolvedProject(config: ResolvedProjectConfig): void {
  const appExports = discoverAppEntry(config.appEntryPath)
  const routes =
    config.apiDir === false ? [] : discoverApiRoutes(config.apiDir, config.options.apiPrefix)
  generateBuildArtifacts({
    generatedDir: config.generatedDir,
    appEntryPath: config.appEntryPath,
    appExports,
    routes,
    apiPrefix: config.options.apiPrefix,
    target: config.options.target,
  })
}
