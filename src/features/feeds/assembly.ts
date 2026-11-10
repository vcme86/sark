/** Subscription endpoint assembly for generated applications. */
import { getCurrentScope } from '../../app/context'
import type { EnvironmentRequirement } from '../../app/declaration'
import type { RouteEntry } from '../../app/http/assembly'
import type { Context } from '../../app/http/types'
import type { ServiceAssembly, ServiceRuntime } from '../../app/service'
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
  let staticConfig: readonly ResolvedFeedConfig[] | undefined
  return {
    prepare(env) {
      const configs = declaration.isFactory
        ? resolveFeedsConfig(declaration, env)
        : (staticConfig ??= resolveFeedsConfig(declaration, env))
      return {
        routes: configs.map(createFeedRoute),
        create: () => ({}),
      }
    },
  }
}

function createFeedRoute(config: ResolvedFeedConfig): RouteEntry {
  const path = config.path
  return {
    source: `feeds:${config.name}`,
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
        const signal = getCurrentScope()!.signal!
        signal.throwIfAborted()
        const content = await config.load(ctx as Context)
        signal.throwIfAborted()
        return new Response(generateFeed(config, content), { headers: config.responseHeaders })
      },
    },
  }
}
