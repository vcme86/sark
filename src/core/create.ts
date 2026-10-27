/**
 * Application instance creation, request dispatch, and lifecycle integration.
 *
 * @module
 */

import type { Hono } from 'hono'

import type { ResolvedHttpConfig } from '../web/http/config'
import { formatErrorResponse } from '../web/http/server/output'
import { buildHttpApp, type RouteEntry } from '../web/http/server/pipeline'
import { applyResponseHeaders } from '../web/http/server/request-context'
import { resolveAppConfig } from './config'
import { getCurrentScope, runInScope, runWithoutScope } from './context'
import type { EnvironmentArgs } from './declaration'
import type { ApplicationDefinition } from './definition'
import { applicationLifecycles, LifecycleManager } from './lifecycle'
import { ensureBasicLogging } from './logging'
import type { ServiceBindingFactory, ServicePreparation } from './service'
import type { AppInstance } from './types'

/** Resolved configuration supplied by a fixed-instance or event host. */
export type AssembleOptions =
  | { readonly kind: 'static'; readonly config: ResolvedHttpConfig; readonly env?: unknown }
  | {
      readonly kind: 'event'
      readonly resolve: (env: unknown) => ResolvedHttpConfig
      /** Used only to format failures before event configuration is available. */
      readonly errorConfig: ResolvedHttpConfig
    }

/**
 * Assembles reusable routes and lifecycle state from the host's configuration source.
 * Event hosts resolve once per external event; internal calls reuse the enclosing result.
 *
 * @param definition - Compiled application definition.
 * @param options - Resolved static settings or the event host's resolver and failure settings.
 * @returns Ready application instance.
 */
export async function assembleApp<D extends ApplicationDefinition>(
  definition: D,
  options: AssembleOptions,
): Promise<AppInstance<D>> {
  ensureBasicLogging()
  const lifecycle = new LifecycleManager()

  try {
    const staticPageConfig =
      options.kind === 'static' ? definition.resolvePageConfig?.(options.env) : undefined
    let instanceRef: AppInstance<D> | undefined

    const serviceRuntimes = Object.entries(definition.services ?? {}).map(
      ([name, assembly]) => [name, assembly.createRuntime()] as const,
    )

    async function prepareServices(env: unknown, config: ResolvedHttpConfig) {
      const preparations = new Map<string, ServicePreparation<unknown>>()
      const routes = [...definition.routes]
      for (const [name, runtime] of serviceRuntimes) {
        const preparation = await runtime.prepare(env, config)
        preparations.set(name, preparation)
        routes.push(...(preparation.routes ?? []))
      }
      return { preparations, routes }
    }

    const staticPlan =
      options.kind === 'static' ? await prepareServices(options.env, options.config) : undefined

    // Compile the complete route graph before opening resources, using one conflict policy.
    const staticHonoApp =
      options.kind === 'static'
        ? buildHttpApp(
            options.config,
            staticPlan!.routes,
            () => instanceRef,
            definition.apiPrefix,
            definition.page404Handler,
            definition.webPrefix,
          )
        : undefined
    let cachedEventHonoApp: Hono<any> | undefined
    let cachedEventRoutes: readonly RouteEntry[] | undefined

    const staticResources: Record<string, unknown> = {}
    const assembledResources = Object.entries(definition.resources ?? {})

    for (const [name, res] of assembledResources) {
      if (options.kind === 'static') {
        if (res.target === 'cloudflare' || !res.createStatic) {
          throw new Error(`Resource "${name}" cannot be used on a Node.js host.`)
        }
        const result = await res.createStatic(options.env, { signal: lifecycle.signal })
        staticResources[name] = result.value
        if (result.dispose) {
          lifecycle.register({ name, dispose: result.dispose })
        }
      } else if (options.kind === 'event') {
        if (res.target === 'node' || !res.createForEvent) {
          throw new Error(`Resource "${name}" cannot be used on a Cloudflare Workers host.`)
        }
      }
    }

    const staticServices = staticPlan
      ? createServices(staticPlan.preparations, staticResources)
      : undefined

    function currentConfig(): ResolvedHttpConfig {
      if (options.kind === 'static') return options.config
      const scope = getCurrentScope()
      if (!scope?.config || scope.app !== instanceRef) {
        throw new Error('Event configuration requires the current application scope.')
      }
      return scope.config
    }

    lifecycle.setReady()

    const executeTracked = async (
      request: Request,
      requestEnv?: unknown,
      executionCtx?: unknown,
    ): Promise<Response> => {
      lifecycle.beginRequest()
      const parent = getCurrentScope()
      const isInternal = parent?.app === instanceRef && parent?.isInternal === true
      const requestId =
        (isInternal ? parent.requestId : undefined) ||
        (executionCtx ? request.headers.get('cf-ray') : undefined) ||
        crypto.randomUUID()
      let effectiveConfig: ResolvedHttpConfig | undefined

      try {
        effectiveConfig = isInternal
          ? currentConfig()
          : options.kind === 'event'
            ? options.resolve(requestEnv)
            : options.config
        const pageConfig = isInternal
          ? parent.pageConfig
          : options.kind === 'static'
            ? staticPageConfig
            : definition.resolvePageConfig?.(requestEnv)

        const eventPlan =
          !isInternal && options.kind === 'event'
            ? await prepareServices(requestEnv, effectiveConfig)
            : undefined

        let activeApp = isInternal ? parent.httpApp! : staticHonoApp
        if (eventPlan) {
          const routes = eventPlan.routes
          if (
            !cachedEventRoutes ||
            routes.length !== cachedEventRoutes.length ||
            routes.some((route, index) => route !== cachedEventRoutes![index])
          ) {
            cachedEventHonoApp = buildHttpApp(
              currentConfig,
              routes,
              () => instanceRef,
              definition.apiPrefix,
              definition.page404Handler,
              definition.webPrefix,
            )
            cachedEventRoutes = routes
          }
          activeApp = cachedEventHonoApp!
        }

        let currentResources: Readonly<Record<string, unknown>>
        if (isInternal) {
          currentResources = parent.resources!
        } else if (options.kind === 'event') {
          const resources: Record<string, unknown> = {}
          for (const [name, res] of assembledResources) {
            const result = await res.createForEvent!(requestEnv)
            resources[name] = result.value
          }
          currentResources = resources
        } else {
          currentResources = staticResources
        }

        const eventServices = eventPlan
          ? createServices(eventPlan.preparations, currentResources)
          : undefined
        const currentServices = isInternal
          ? parent.services
          : (staticServices ?? eventServices)!.services
        const currentBindingFactories = isInternal
          ? parent.serviceBindingFactories
          : (staticServices ?? eventServices)!.factories

        return await runInScope(
          {
            ...parent,
            requestId,
            app: instanceRef,
            config: effectiveConfig,
            pageConfig,
            resources: currentResources,
            services: currentServices,
            serviceBindingFactories: currentBindingFactories,
            serviceBindings: isInternal ? parent.serviceBindings : undefined,
            httpApp: activeApp,
            env: options.kind === 'event' ? requestEnv : options.env,
            executionCtx,
          },
          () => activeApp!.fetch(request, requestEnv, executionCtx as any),
        )
      } catch (err) {
        const errorConfig =
          effectiveConfig ?? (options.kind === 'static' ? options.config : options.errorConfig)
        const response = runInScope({ requestId, app: instanceRef }, () =>
          formatErrorResponse(err, errorConfig.production),
        )
        return applyResponseHeaders(
          request.method === 'HEAD' ? new Response(null, response) : response,
          errorConfig,
          requestId,
        )
      } finally {
        lifecycle.endRequest()
      }
    }

    const instance = {
      definition,
      get config() {
        return currentConfig()
      },
      get hono() {
        return staticHonoApp ?? cachedEventHonoApp
      },
      get state() {
        return lifecycle.state
      },
      fetch(request: Request, requestEnv?: unknown, executionCtx?: unknown) {
        return runWithoutScope(() => executeTracked(request, requestEnv, executionCtx))
      },
      fetchInternal(request: Request) {
        const parent = getCurrentScope()
        if (parent?.app !== instance) return instance.fetch(request)
        const internalRequest = parent.signal
          ? new Request(request, { signal: AbortSignal.any([parent.signal, request.signal]) })
          : request
        return runInScope({ ...parent, isInternal: true }, async () => {
          const response = await executeTracked(internalRequest, parent.env, parent.executionCtx)
          parent.appendCookies?.(response.headers.getSetCookie())
          return response
        })
      },
      close(): Promise<void> {
        return lifecycle.close()
      },
    } as AppInstance<D>

    for (const [name] of assembledResources) {
      Object.defineProperty(instance, name, {
        get() {
          if (options.kind === 'static') return staticResources[name]
          const scope = getCurrentScope()
          if (scope && scope.app === instanceRef && scope.resources) {
            return scope.resources[name]
          }
          throw new Error(`Resource "${name}" is only accessible within an active event context.`)
        },
        enumerable: true,
      })
    }

    if (definition.services) {
      for (const [name, assembly] of Object.entries(definition.services)) {
        if (!assembly.expose) continue
        Object.defineProperty(instance, name, {
          get() {
            if (options.kind === 'static') return staticServices!.services[name]
            const scope = getCurrentScope()
            if (scope && scope.app === instanceRef && scope.services) {
              return scope.services[name]
            }
            throw new Error(`Service "${name}" is only accessible within an active event context.`)
          },
          enumerable: true,
        })
      }
    }

    applicationLifecycles.set(instance, lifecycle)
    instanceRef = instance
    return instance
  } catch (err) {
    lifecycle.cancel(
      err instanceof Error ? err : new Error('Application initialization failed', { cause: err }),
    )
    try {
      await lifecycle.disposeAll()
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], 'Application creation and cleanup failed', {
        cause: cleanupError,
      })
    }
    throw err
  }
}

function createServices(
  preparations: Map<string, ServicePreparation<unknown>>,
  resources: Readonly<Record<string, unknown>>,
) {
  const services: Record<string, unknown> = {}
  const factories: Record<string, ServiceBindingFactory> = {}
  for (const [name, preparation] of preparations) {
    const result = preparation.create(resources)
    if (result.instanceService !== undefined) services[name] = result.instanceService
    if (result.createBinding) factories[name] = result.createBinding
  }
  return { services, factories }
}

/**
 * Resolves application configuration and creates an instance ready for requests.
 * Factory declarations require an environment. Initialization failure cancels
 * creation work and disposes registered resources before propagating the error.
 *
 * @param definition - Compiled application definition containing configuration and routes.
 * @param options - Creation options containing env; required when the definition requires an environment.
 * @returns A ready application instance. Call close to release its resources.
 * @throws {Error} If the application factory requires an environment and env is omitted.
 * @throws {AggregateError} If initialization fails and subsequent resource cleanup also throws.
 */
export async function createApp<D extends ApplicationDefinition>(
  definition: D,
  ...options: EnvironmentArgs<D>
): Promise<AppInstance<D>> {
  const env = options[0]?.env
  return assembleApp(definition, {
    kind: 'static',
    config: resolveAppConfig(definition.appDeclaration, env, process.env.NODE_ENV === 'production'),
    env,
  })
}
