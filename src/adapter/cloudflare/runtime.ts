/**
 * Cloudflare Workers runtime adapter and Fetch event handler.
 *
 * @module
 */

import { Context } from 'hono'
import { cors } from 'hono/cors'

import { resolveAppConfig } from '../../core/config'
import { assembleApp } from '../../core/create'
import type { EnvOf } from '../../core/declaration'
import type { ApplicationDefinition } from '../../core/definition'
import type { AppInstance } from '../../core/types'
import { type ResolvedHttpConfig, resolveHttpConfig } from '../../web/http/config'
import { applyResponseHeaders } from '../../web/http/server/request-context'
import { decorateCloudflareAssetResponse } from './assets'

/** Cloudflare Workers standard execution context interface. */
export interface CloudflareExecutionContext {
  /**
   * Registers background work with the platform's event lifetime.
   *
   * @param promise - Work that may continue after the response, within platform limits.
   */
  waitUntil(promise: Promise<unknown>): void
  /** Allows the request to fail open to the origin server on unhandled exceptions. */
  passThroughOnException(): void
}

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
export function createWorkerHandler<D extends ApplicationDefinition>(
  definition: D,
  production = true,
): CloudflareWorkerHandler<EnvOf<D>> {
  let instancePromise: Promise<AppInstance<D>> | undefined
  let staticConfig: ResolvedHttpConfig | undefined

  async function getInstance(): Promise<AppInstance<D>> {
    if (!instancePromise) {
      const declaration = definition.appDeclaration
      let resolveConfig: (env: unknown) => ResolvedHttpConfig
      if (typeof declaration?.value === 'function') {
        resolveConfig = (env) => resolveAppConfig(declaration, env, production)
      } else {
        const config = resolveAppConfig(declaration, undefined, production)
        resolveConfig = () => config
      }
      instancePromise = assembleApp(definition, {
        kind: 'event',
        resolve: resolveConfig,
        errorConfig: resolveHttpConfig({}, production),
      }).catch((err) => {
        instancePromise = undefined
        throw err
      })
    }
    return instancePromise
  }

  return {
    async fetch(request, env, ctx): Promise<Response> {
      const assets = definition.assets
      const binding = (
        env as { ASSETS?: { fetch(request: Request): Promise<Response> } } | undefined
      )?.ASSETS
      if (
        assets &&
        binding &&
        (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS')
      ) {
        const base = new URL(assets.base, request.url).pathname
        const path = new URL(request.url).pathname
        let entry: (typeof assets.files)[string] | undefined
        if (path.startsWith(base)) {
          try {
            const key = decodeURIComponent(path.slice(base.length))
            if (Object.hasOwn(assets.files, key)) entry = assets.files[key]
          } catch {
            /* Invalid URL paths do not identify a build resource. */
          }
        }
        if (entry) {
          const declaration = definition.appDeclaration
          const config = declaration?.isFactory
            ? resolveAppConfig(declaration, env, production)
            : (staticConfig ??= resolveAppConfig(declaration, undefined, production))
          const context = new Context(request, { env })
          const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID()
          context.set('requestId', requestId)
          const deliver = async () => {
            const assetUrl = new URL(request.url)
            // Production ASSETS uses output-root paths. The official development
            // binding delegates to Vite middleware, which requires its public base.
            if (production)
              assetUrl.pathname = '/' + entry!.path.split('/').map(encodeURIComponent).join('/')
            context.res = decorateCloudflareAssetResponse(
              await binding.fetch(new Request(assetUrl, request)),
              entry!.hashed,
            )
          }
          if (config.cors !== false) await cors(config.cors)(context, deliver)
          else await deliver()
          return applyResponseHeaders(context.res, config, requestId)
        }
      }

      const instance = await getInstance()
      return instance.fetch(request, env, ctx)
    },
  }
}
