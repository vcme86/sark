/**
 * Visitor assembly implementation selected by generated application code.
 *
 * @module
 */

import type { EnvironmentRequirement } from '../../core/declaration'
import type {
  RequestBindingContext,
  ServiceAssembly,
  ServiceBinding,
  ServiceRuntime,
} from '../../core/service'
import { type ParsedRoutePath, routeShape } from '../../http/path'
import type { RouteEntry } from '../../http/server/types'
import { resolveVisitorsConfig, type VisitorsDeclaration } from './config'
import { initRequestVisitor, type RequestVisitorState } from './request'
import type { RequestVisitor, ResolvedVisitorsConfig } from './types'

/**
 * Creates visitor service assembly for application definition.
 *
 * @param input - Visitors declaration.
 * @returns Assembly defining runtime routes and request-scoped bindings.
 */
export function createVisitorsAssembly<T extends VisitorsDeclaration>(
  input: T,
): ServiceAssembly<never> & EnvironmentRequirement<readonly [T]>
export function createVisitorsAssembly(input: VisitorsDeclaration): ServiceAssembly<never> {
  return {
    expose: false,
    createRuntime: () => createVisitorsRuntime(input),
  }
}

/** Reuses endpoint descriptions across events without capturing event-specific configuration. */
function createVisitorsRuntime(input: VisitorsDeclaration): ServiceRuntime<never> {
  let staticConfig: ResolvedVisitorsConfig | undefined
  let cachedEndpoint: { path: string; routes: readonly RouteEntry[] } | undefined

  return {
    prepare(env, httpConfig) {
      const config = input.isFactory
        ? resolveVisitorsConfig(input.value, env, httpConfig.production)
        : (staticConfig ??= resolveVisitorsConfig(input.value, env, httpConfig.production))

      if (cachedEndpoint?.path !== config.path) {
        const routePath: ParsedRoutePath = {
          urlPath: config.path,
          clientPath: config.path,
          shapeKey: routeShape(config.path),
          method: 'POST',
          segments: config.path
            .split('/')
            .filter(Boolean)
            .map((raw: string) => ({ kind: 'static', raw })),
          isSse: false,
          isWs: false,
        }

        const route: RouteEntry = {
          kind: 'api',
          routePath,
          source: 'visitors:init',
          declaration: {
            isRoute: true,
            options: { middleware: [] },
            validators: {},
            handler: async (ctx) => {
              const visitor = (ctx.var as { visitor?: RequestVisitor }).visitor!
              await visitor.ensure()
              return new Response(null, {
                status: 204,
                headers: {
                  'Cache-Control': 'no-store',
                },
              })
            },
          },
        }

        cachedEndpoint = {
          path: config.path,
          routes: [route],
        }
      }

      return {
        routes: cachedEndpoint.routes,
        create: () => ({
          createBinding: (context) => createVisitorBinding(config, context),
        }),
      }
    },
  }
}

async function createVisitorBinding(
  config: ResolvedVisitorsConfig,
  context: RequestBindingContext,
): Promise<ServiceBinding> {
  const { state, visitor } = await initRequestVisitor(config, {
    ctx: context.ctx,
    parentState: context.parentBinding?.state as RequestVisitorState | undefined,
    appendCookie: context.appendCookie,
    isHeadersCommitted: context.isHeadersCommitted,
  })

  context.ctx.set('visitor', visitor)

  return {
    state,
    onCommitHeaders() {
      if (state.cookieModified) {
        context.ctx.header('Cache-Control', 'no-store')
      }
    },
  }
}
