/** Node delivery shared by the production listener and the Vite request adapter. */
import { Hono, type MiddlewareHandler } from 'hono'
import { compress as honoCompress } from 'hono/compress'

import { publicRequest } from '../../app/http/public'
import { applicationLogging } from '../../app/logging'
import type { AppInstance } from '../../app/types'
import { findStaticAsset, type StaticAssets } from '../../http/assets'
import { requestCompressionPolicies } from '../../middleware/compress'
import type { ResolvedCompressionOptions } from '../../middleware/compression'
import { mountNodeProbes } from './probes'
import type { PreparedNodeRuntime } from './runtime'
import { createNodeStaticHandler } from './static'

/**
 * Builds Node probes, compression, and optional static delivery around business dispatch.
 *
 * @param instance - Ready application; public branches bypass its business bindings.
 * @param config - Prepared host policy, shared by development and production.
 * @param build - Optional deployment root and exact public file mapping.
 * @returns Hono delivery application; the transport owner supplies native completion metadata.
 */
export function createNodeDeliveryApp(
  instance: AppInstance<any>,
  config: PreparedNodeRuntime,
  build?: { readonly rootDir: string; readonly assets: StaticAssets },
): Hono {
  const deliveryApp = new Hono()

  // Probes bypass business admission and compression, including during draining.
  mountNodeProbes(deliveryApp, instance, config.probes, config.health)

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

  if (build) {
    const staticHandler = createNodeStaticHandler({
      rootDir: build.rootDir,
      assets: build.assets,
    })
    const publicBoundary = publicRequest(
      instance.config,
      applicationLogging.get(instance),
      instance,
    )
    deliveryApp.use('*', async (ctx, next) => {
      if (
        ['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method) &&
        findStaticAsset(build.assets, new URL(ctx.req.url).pathname)
      ) {
        await publicBoundary(ctx, async () => {
          ctx.res = (await staticHandler(ctx.req.raw)) ?? new Response(null, { status: 404 })
        })
        return ctx.res
      }
      return next()
    })
  }

  deliveryApp.all('*', (ctx) => instance.fetch(ctx.req.raw, ctx.env))

  return deliveryApp
}
