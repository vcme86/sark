/** Subscription endpoint assembly for generated applications. */
import { getCurrentScope } from '../../app/context'
import type { EnvironmentRequirement } from '../../app/declaration'
import type { RouteEntry } from '../../app/http/assembly'
import type { Context } from '../../app/http/types'
import type { ServiceAssembly, ServicePreparation, ServiceRuntime } from '../../app/service'
import { routeShape } from '../../http/path'
import { type FeedsDeclaration, resolveFeedsConfig } from './config'
import { generateFeed } from './generate'
import type { ResolvedFeedConfig } from './types'

/**
 * Selects subscription endpoints for generated application assembly.
 *
 * @param declaration - Named subscription declaration with optional environment requirements.
 * @returns A route-only service assembly.
 */
export function createFeedsAssembly<T extends FeedsDeclaration>(
  declaration: T,
): ServiceAssembly<never> & EnvironmentRequirement<readonly [T]>
export function createFeedsAssembly(declaration: FeedsDeclaration): ServiceAssembly<never> {
  return { expose: false, createRuntime: () => createFeedsRuntime(declaration) }
}

function createFeedsRuntime(declaration: FeedsDeclaration): ServiceRuntime<never> {
  let staticPreparation: ServicePreparation<never> | undefined
  let graph: { key: string; routes: readonly RouteEntry[] } | undefined
  return {
    prepare(env) {
      if (staticPreparation) return staticPreparation
      const configs = resolveFeedsConfig(declaration, env)
      const key = JSON.stringify(configs.map(({ name, path }) => [name, path]))
      if (graph?.key !== key) graph = { key, routes: configs.map(createFeedRoute) }
      const state = new Map(configs.map((config) => [config.name, config]))
      const preparation = {
        routes: graph.routes,
        create: () => ({ createBinding: () => ({ state }) }),
      }
      if (!declaration.isFactory) staticPreparation = preparation
      return preparation
    },
  }
}

function createFeedRoute({ name, path }: ResolvedFeedConfig): RouteEntry {
  return {
    source: `feeds:${name}`,
    routePath: {
      urlPath: path,
      clientPath: path,
      shapeKey: routeShape(path),
      method: 'GET',
      segments: path
        .split('/')
        .filter(Boolean)
        .map((raw) => ({ kind: 'static', raw })),
      isSse: false,
      isWs: false,
    },
    declaration: {
      isRoute: true,
      options: { middleware: [] },
      validators: {},
      handler: async (ctx) => {
        const scope = getCurrentScope()!
        const feeds = scope.serviceBindings!.feeds.state as ReadonlyMap<string, ResolvedFeedConfig>
        const config = feeds.get(name)!
        const signal = scope.signal!
        signal.throwIfAborted()
        const content = await config.load(ctx as Context)
        signal.throwIfAborted()
        return new Response(generateFeed(config, content), { headers: config.responseHeaders })
      },
    },
  }
}
