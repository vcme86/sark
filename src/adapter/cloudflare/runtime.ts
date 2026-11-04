/**
 * Cloudflare Workers runtime adapter and Fetch event handler.
 *
 * @module
 */

import type {
  WebSocket as WorkerWebSocket,
  WebSocketPair as WorkerWebSocketPair,
} from '@cloudflare/workers-types'
import { jsonLinesFormatter } from '@logtape/logtape'

import { resolveAppConfig, type ResolvedHttpConfig, resolveHttpConfig } from '../../app/config'
import { assembleApp } from '../../app/create'
import type { EnvOf } from '../../app/declaration'
import type { AppDefinition } from '../../app/definition'
import { getWsUpgradeState } from '../../app/http/websocket'
import { applicationLifecycles } from '../../app/lifecycle'
import { ensureBasicLogging } from '../../app/logging'
import type { AppInstance } from '../../app/types'
import type { CloudflareExecutionContext, ScheduledController } from './types'
import { runCloudflareWebSocket } from './websocket'

export type { CloudflareExecutionContext, ScheduledController } from './types'

/** Standard Cloudflare Worker module export interface with typed environment bindings. */
export interface CloudflareWorkerHandler<Env = unknown> {
  /**
   * Handles a Workers Fetch event.
   *
   * @param request - Incoming request supplied by the platform.
   * @param env - Bindings for this event.
   * @param ctx - Platform execution context, including waitUntil.
   * @returns The application response.
   */
  fetch(request: Request, env: Env, ctx: CloudflareExecutionContext): Promise<Response>

  /**
   * Handles a Workers Scheduled event.
   *
   * @param controller - Scheduled event controller containing the platform cron string.
   * @param env - Bindings for this event.
   * @param ctx - Platform execution context, including waitUntil.
   */
  scheduled?(
    controller: ScheduledController,
    env: Env,
    ctx: CloudflareExecutionContext,
  ): Promise<void>
}

/**
 * Creates a Workers Fetch handler that reuses application assembly across events.
 *
 * Request handling:
 * 1. Reuse the initialized application; failed assembly is retried on the next event.
 * 2. Resolve factories with the current event's env; reuse environment-independent object settings.
 * 3. Expose bindings as Hono ctx.env and the platform context as ctx.executionCtx.
 *
 * Internal requests inherit the enclosing event's configuration and bindings.
 * The adapter does not start a Node server; shared scopes use node:async_hooks
 * through Workers compatibility support.
 *
 * @param definition - Compiled application definition.
 * @param production - Vite's production flag, or true for a standalone Worker host.
 * @returns Object exposing `fetch(request, env, ctx)` compatible with Cloudflare Workers.
 */
export function createWorkerHandler<D extends AppDefinition>(
  definition: D,
  production = true,
): CloudflareWorkerHandler<EnvOf<D>> {
  let instancePromise: Promise<AppInstance<D>> | undefined
  let staticConfig: ResolvedHttpConfig | undefined
  const errorConfig = resolveHttpConfig({}, production)

  const declaration = definition.app
  const resolveConfig = declaration?.isFactory
    ? (env: unknown) => resolveAppConfig(declaration, env, production)
    : (_env: unknown) => (staticConfig ??= resolveAppConfig(declaration, undefined, production))

  async function getInstance(): Promise<AppInstance<D>> {
    ensureBasicLogging(jsonLinesFormatter)
    if (!instancePromise) {
      if (!declaration?.isFactory) resolveConfig(undefined)
      instancePromise = assembleApp(definition, {
        kind: 'event',
        resolve: resolveConfig,
        errorConfig,
      }).catch((err) => {
        instancePromise = undefined
        throw err
      })
    }
    return instancePromise
  }

  return {
    async fetch(request, env, ctx): Promise<Response> {
      const instance = await getInstance()
      const res = await instance.fetch(request, env, ctx)
      const upgradeState = getWsUpgradeState(res)
      if (upgradeState) {
        const { WebSocketPair } = globalThis as unknown as {
          WebSocketPair: typeof WorkerWebSocketPair
        }
        let serverSocket: WorkerWebSocket | undefined
        let accepted = false
        let transferred = false
        try {
          const pair = new WebSocketPair()
          serverSocket = pair[1]
          serverSocket.binaryType = 'arraybuffer'
          serverSocket.accept()
          accepted = true
          const init: ResponseInit & { webSocket: WorkerWebSocket } = {
            status: 101,
            webSocket: pair[0],
            headers: res.headers,
          }
          const response = new Response(null, init)
          runCloudflareWebSocket({
            serverSocket,
            handlers: upgradeState.handlers,
            connectionScope: upgradeState.scope,
            lifecycle: applicationLifecycles.get(instance),
            release: upgradeState.release!,
            executionCtx: ctx,
            connectionAbort: upgradeState.connectionAbort,
          })
          upgradeState.complete?.(101, 'ok')
          transferred = true
          return response
        } finally {
          if (!transferred) {
            upgradeState.complete?.(undefined, 'error')
            upgradeState.connectionAbort.abort()
            try {
              if (accepted) serverSocket!.close(1011, 'WebSocket initialization failed')
            } finally {
              await upgradeState.release!()
            }
          }
        }
      }
      return res
    },

    async scheduled(controller, env, ctx): Promise<void> {
      const instance = await getInstance()
      if (!definition.scheduled) {
        throw new Error(`No scheduled jobs defined, received cron "${controller.cron}".`)
      }
      await definition.scheduled(controller, env, ctx, instance)
    },
  }
}
