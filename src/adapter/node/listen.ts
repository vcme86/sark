/**
 * Node HTTP hosting, response delivery, and graceful shutdown.
 *
 * @module
 */

import { serve, type ServerType } from '@hono/node-server'
import { Hono, type MiddlewareHandler } from 'hono'
import { compress as honoCompress } from 'hono/compress'

import type { RequiresEnv } from '../../core/declaration'
import { applicationLifecycles } from '../../core/lifecycle'
import { getLogger } from '../../core/logging'
import type { AppInstance } from '../../core/types'
import type { StaticAssets } from '../../http/assets'
import type { ResolvedCompressionOptions } from '../../http/compression'
import { requestCompressionPolicies } from '../../http/middleware/compress'
import { cors } from '../../http/middleware/cors'
import { applyResponseHeaders } from '../../http/server/request-context'
import { waitUntil } from './deadline'
import { mountNodeProbes } from './probes'
import { type NodeRuntimeDeclaration, resolveNodeRuntime } from './runtime'
import { createNodeStaticHandler } from './static'

/** Controller handle exposing the running Node.js HTTP server and shutdown trigger. */
export interface NodeServerControl {
  /** Underlying Node.js HTTP server instance. */
  readonly server: ServerType
  /** Actual port bound by the server (useful when ephemeral port 0 is requested). */
  readonly port: number
  /** Hostname or IP interface bound by the server. */
  readonly hostname?: string
  /**
   * Closes the listener and application using the configured shutdown budget.
   * Repeated calls share the same shutdown operation and do not exit the process.
   *
   * @returns A promise resolving after transport draining and application disposal complete.
   * @throws If draining or disposal fails or exceeds its deadline.
   * Multiple failures are reported in an AggregateError.
   */
  close(): Promise<void>
}

/** Environment requirements and optional build assets accepted by the Node host. */
type RuntimeEnvRequirement<R> =
  R extends RequiresEnv<infer E>
    ? [env: E, build?: NodeBuildAssets]
    : [env?: NodeJS.ProcessEnv, build?: NodeBuildAssets]

/** Location of the deployed build and its generated public resource mapping. */
interface NodeBuildAssets {
  /** Directory containing the deployed server entry and its public build files. */
  readonly rootDir: string
  /** Public URL mapping with file paths relative to rootDir. */
  readonly assets: StaticAssets
}

/**
 * Starts the Node HTTP host with probes, compression, and graceful shutdown.
 *
 * Startup order:
 * 1. Resolve runtime settings and validate listening/shutdown config.
 * 2. Mount probes before compression and business request forwarding.
 * 3. Register response compression, optional build assets, and business forwarding.
 * 4. Prepare selected WebSocket support, then bind the listener and wait for startup.
 * 5. Register SIGTERM/SIGINT handlers and return the server control handle.
 *
 * Shutdown order:
 * 1. Stop external admission and close the listener.
 * 2. Wait for active handlers and response streams within deadline - reserve.
 * 3. If draining fails or times out, signal cancellation and close remaining connections.
 * 4. Release the disposal barrier and wait for application cleanup until the total deadline.
 *
 * Signal behavior:
 * - Manual close rejects on shutdown failure without exiting the process.
 * - SIGTERM/SIGINT use the same close path, then exit with its success/failure status.
 * - A second signal exits immediately with status 1.
 *
 * @param instance - Initialized Sark application instance.
 * @param runtimeDecl - Optional Node runtime declaration created with `defineNodeRuntime`.
 * @param args - Environment for the runtime factory and PORT resolution (defaults to process.env),
 *   followed by optional deployed build assets.
 * @returns Server control handle with port and `close()` method.
 * @throws {Error} If runtime configuration or listener startup fails.
 * @throws {AggregateError} If startup fails and application cleanup also throws.
 */
export async function startNodeServer<R extends NodeRuntimeDeclaration | undefined = undefined>(
  instance: AppInstance<any>,
  runtimeDecl?: R,
  ...args: RuntimeEnvRequirement<R>
): Promise<NodeServerControl> {
  const env = args[0] ?? process.env
  try {
    const config = resolveNodeRuntime(runtimeDecl, env)

    const deliveryApp = new Hono()

    // Probes bypass business admission and compression, including during draining.
    mountNodeProbes(deliveryApp, instance, config.probes)

    const compressors = new WeakMap<ResolvedCompressionOptions, MiddlewareHandler>()
    deliveryApp.use('*', async (ctx, next) => {
      await next()
      const override = requestCompressionPolicies.get(ctx.req.raw)
      const policy = override === undefined ? config.compress : override
      if (policy === false || ctx.req.header('range')) return
      if (ctx.res.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return

      let compressor = compressors.get(policy)
      if (!compressor) {
        compressor = honoCompress(policy)
        compressors.set(policy, compressor)
      }
      return compressor(ctx, async () => {})
    })

    const build = args[1]
    if (build) {
      const staticHandler = createNodeStaticHandler({
        rootDir: build.rootDir,
        assets: build.assets,
      })
      const staticCors = instance.config.cors === false ? undefined : cors(instance.config.cors)
      deliveryApp.use('*', async (ctx, next) => {
        if (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') {
          const staticRes = await staticHandler(ctx.req.raw)
          if (staticRes) {
            ctx.res = ctx.newResponse(staticRes.body, staticRes)
            if (staticCors) await staticCors(ctx, async () => {})
            return applyResponseHeaders(ctx.res, instance.config, crypto.randomUUID())
          }
        }
        return next()
      })
    }

    deliveryApp.all('*', (ctx) => instance.fetch(ctx.req.raw, ctx.env))

    const hasWs = instance.definition.routes.some(
      (r: { routePath: { isWs?: boolean } }) => r.routePath.isWs,
    )
    let wsBridge: import('./websocket').NodeWebSocketBridge | undefined
    let writeResponseFn: typeof import('./websocket').writeServerResponse | undefined
    if (hasWs) {
      const { createNodeWebSocketBridge, writeServerResponse } = await import('./websocket')
      wsBridge = createNodeWebSocketBridge(instance)
      writeResponseFn = writeServerResponse
    }

    let serverInstance!: ServerType
    let resolvedPort = config.port

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      serverInstance = serve(
        {
          fetch: (request, serverEnv) => deliveryApp.fetch(request, serverEnv),
          port: config.port,
          hostname: config.hostname,
        },
        (info) => {
          serverInstance.removeListener('error', onError)
          resolvedPort = info.port
          resolve()
        },
      )
      serverInstance.once('error', onError)
    })

    if (wsBridge && writeResponseFn) {
      const bridge = wsBridge
      const writer = writeResponseFn
      serverInstance.on('upgrade', (req, socket, head) => {
        bridge
          .handleUpgrade(req, socket, head)
          .then(async (handled) => {
            if (!handled) {
              await writer(req, socket, new Response('Not Found', { status: 404 }))
            }
          })
          .catch((err) => {
            getLogger().error('Unhandled error during WebSocket upgrade: {error}', { error: err })
            try {
              socket.destroy(err instanceof Error ? err : new Error(String(err)))
            } catch {}
          })
      })
    }

    if ('closeIdleConnections' in serverInstance) {
      const httpServer = serverInstance
      httpServer.on('request', (_request, response) => {
        response.once('finish', () => {
          // Connections active when close() began become idle after their response finishes.
          if (!httpServer.listening) httpServer.closeIdleConnections()
        })
      })
    }

    getLogger().info(`Node server listening on port ${resolvedPort}`)

    const lifecycle = applicationLifecycles.get(instance)!
    let closePromise: Promise<void> | undefined
    function closeServer(): Promise<void> {
      if (closePromise) return closePromise
      const deadline = performance.now() + config.shutdown.deadline
      const transportDrained = Promise.withResolvers<void>()
      lifecycle.deferDisposalUntil(transportDrained.promise, deadline)
      const applicationClosed = instance.close().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      closePromise = (async () => {
        const transportClosed = new Promise<void>((resolve, reject) => {
          serverInstance.close((error) => (error ? reject(error) : resolve()))
        })
        const bridgeClosed = wsBridge ? wsBridge.close(deadline) : Promise.resolve()
        const errors: unknown[] = []
        try {
          const drained = await waitUntil(
            Promise.all([transportClosed, bridgeClosed, lifecycle.waitForIdle()]),
            deadline - config.shutdown.reserve,
          )
          if (!drained) {
            const timeout = new Error('Graceful shutdown exceeded the request drain budget')
            errors.push(timeout)
            getLogger().warn(timeout.message, { pendingRequests: lifecycle.pendingRequests })
            lifecycle.cancel(timeout)
            if ('closeAllConnections' in serverInstance) serverInstance.closeAllConnections()
          }
        } catch (error) {
          errors.push(error)
          lifecycle.cancel(
            error instanceof Error ? error : new Error('Request drain failed', { cause: error }),
          )
          if ('closeAllConnections' in serverInstance) serverInstance.closeAllConnections()
        } finally {
          transportDrained.resolve()
        }
        try {
          if (!(await waitUntil(applicationClosed, deadline))) {
            errors.push(new Error('Application resource disposal exceeded the shutdown deadline'))
          } else {
            const outcome = await applicationClosed
            if (!outcome.ok && !errors.includes(outcome.error)) errors.push(outcome.error)
          }
        } catch (error) {
          errors.push(error)
        } finally {
          process.removeListener('SIGTERM', onSignal)
          process.removeListener('SIGINT', onSignal)
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, 'Application shutdown failed')
      })()
      return closePromise
    }

    let signalled = false
    const onSignal = () => {
      if (signalled) process.exit(1)
      signalled = true
      closeServer().then(
        () => process.exit(0),
        (error) => {
          getLogger().error('Application shutdown failed', { error })
          process.exit(1)
        },
      )
    }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)

    return {
      server: serverInstance!,
      port: resolvedPort,
      hostname: config.hostname,
      close: closeServer,
    }
  } catch (error) {
    try {
      await instance.close()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Node startup and application cleanup failed',
        { cause: cleanupError },
      )
    }
    throw error
  }
}
