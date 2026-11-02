/**
 * Application instance creation, request dispatch, and lifecycle integration.
 *
 * @module
 */

import { getLogger } from '@logtape/logtape'
import type { Hono } from 'hono'

import type { ResolvedHttpConfig } from '../http/config'
import { formatErrorResponse } from '../http/server/output'
import { buildHttpApp } from '../http/server/pipeline'
import { applyResponseHeaders } from '../http/server/request-context'
import type { RouteEntry } from '../http/server/types'
import { getWsUpgradeState } from '../http/server/websocket'
import { resolveAppConfig } from './config'
import { applicationRoutes, getCurrentScope, runInScope, runWithoutScope } from './context'
import type { EnvironmentArgs } from './declaration'
import type { AppDefinition } from './definition'
import { applicationLifecycles, LifecycleManager } from './lifecycle'
import { ensureBasicLogging } from './logging'
import type { ServiceBindingFactory, ServiceCreateContext, ServicePreparation } from './service'
import type { AppInstance } from './types'

/** Resolved configuration supplied by a fixed-instance or event host. */
type AssembleOptions =
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
export async function assembleApp<D extends AppDefinition>(
  definition: D,
  options: AssembleOptions,
): Promise<AppInstance<D>> {
  ensureBasicLogging()
  const lifecycle = new LifecycleManager()
  const logger = getLogger(['app', 'lifecycle'])
  const trackStaticWork = (promise: Promise<unknown>) => {
    lifecycle.beginRequest()
    void promise
      .catch((error) => logger.error('Background service work failed: {error}', { error }))
      .finally(() => lifecycle.endRequest())
  }

  try {
    const resolvePageConfig = definition.createPageConfigResolver?.()
    const staticPageConfig =
      options.kind === 'static' ? resolvePageConfig?.(options.env) : undefined

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

    if (options.kind === 'event' && definition.assetMounts) {
      throw new Error('assets/node is not supported on Cloudflare Workers.')
    }

    const staticAssetMountHandler =
      options.kind === 'static' && definition.assetMounts
        ? {
            prefixes: definition.assetMounts.prefixes,
            handle: definition.assetMounts.createHandler(),
          }
        : undefined

    // Compile the complete route graph before opening resources, using one conflict policy.
    const staticHonoApp =
      options.kind === 'static'
        ? buildHttpApp(
            options.config,
            staticPlan!.routes,
            () => instance,
            definition.apiPrefix,
            definition.page404Handler,
            definition.webPrefix,
            staticAssetMountHandler,
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

    const staticEnv = options.kind === 'static' ? options.env : undefined
    const staticServices = staticPlan
      ? await createServices(staticPlan.preparations, staticResources, {
          env: staticEnv,
          target: 'node',
          resourceDeclarations: definition.resources ?? {},
          logger,
          waitUntil: trackStaticWork,
          signal: lifecycle.signal,
          registerDispose: (name, dispose) => lifecycle.register({ name, dispose }),
        })
      : undefined

    function currentConfig(): ResolvedHttpConfig {
      if (options.kind === 'static') return options.config
      const scope = getCurrentScope()
      if (!scope?.config || scope.app !== instance) {
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
      const isInternal = parent?.app === instance && parent?.isInternal === true
      const requestId =
        (isInternal ? parent.requestId : undefined) ||
        (executionCtx ? request.headers.get('cf-ray') : undefined) ||
        crypto.randomUUID()
      let effectiveConfig: ResolvedHttpConfig | undefined
      const eventDisposals: Array<() => Promise<void> | void> = []
      const eventWork = new Set<Promise<unknown>>()
      const trackEventWork = (promise: Promise<unknown>) => {
        const tracked = promise.catch((error) =>
          logger.error('Background service work failed: {error}', { error }),
        )
        eventWork.add(tracked)
        void tracked.finally(() => eventWork.delete(tracked))
        ;(
          executionCtx as { waitUntil?: (work: Promise<unknown>) => void } | undefined
        )?.waitUntil?.(tracked)
      }
      const cleanupEventDisposals = async () => {
        await Promise.all(eventWork)
        const errors: unknown[] = []
        while (eventDisposals.length) {
          try {
            await eventDisposals.pop()!()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Event service disposal failed.')
      }

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
            : resolvePageConfig?.(requestEnv)

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
              () => instance,
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
          ? await createServices(eventPlan.preparations, currentResources, {
              env: requestEnv,
              target: 'cloudflare',
              resourceDeclarations: definition.resources ?? {},
              logger,
              waitUntil: trackEventWork,
              signal: request.signal,
              registerDispose: (_name, dispose) => {
                eventDisposals.push(dispose)
              },
            })
          : undefined
        const currentServices = isInternal
          ? parent.services
          : (staticServices ?? eventServices)!.services
        const currentBindingFactories = isInternal
          ? parent.serviceBindingFactories
          : (staticServices ?? eventServices)!.factories

        const rawResponse = await runInScope(
          {
            ...parent,
            requestId,
            app: instance,
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

        const upgradeState = getWsUpgradeState(rawResponse)
        if (upgradeState) {
          lifecycle.beginRequest()
          let release: Promise<void> | undefined
          upgradeState.release = () =>
            (release ??= (async () => {
              try {
                await cleanupEventDisposals()
              } finally {
                lifecycle.endRequest()
              }
            })())
          return rawResponse
        }

        if (eventDisposals.length > 0) {
          return attachDisposal(rawResponse, cleanupEventDisposals, executionCtx)
        }
        return rawResponse
      } catch (failure) {
        let err = failure
        try {
          await cleanupEventDisposals()
        } catch (cleanupError) {
          err = new AggregateError([err, cleanupError], 'Event execution and disposal failed.')
        }
        const errorConfig =
          effectiveConfig ?? (options.kind === 'static' ? options.config : options.errorConfig)
        const response = runInScope({ requestId, app: instance }, () =>
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
          if (scope && scope.app === instance && scope.resources) {
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
            if (scope && scope.app === instance && scope.services) {
              return scope.services[name]
            }
            throw new Error(`Service "${name}" is only accessible within an active event context.`)
          },
          enumerable: true,
        })
      }
    }

    applicationLifecycles.set(instance, lifecycle)
    if (staticHonoApp) applicationRoutes.set(instance, staticHonoApp.routes)
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

/** Retains event services until the response ends, fails, or is cancelled. */
function attachDisposal(
  response: Response,
  cleanup: () => Promise<void>,
  executionCtx?: unknown,
): Response {
  const host = executionCtx as { waitUntil?: (work: Promise<unknown>) => void } | undefined
  let disposal: Promise<void> | undefined
  const finish = () => {
    if (disposal) return
    disposal = cleanup()
    if (host?.waitUntil) host.waitUntil(disposal)
    else
      void disposal.catch((error) =>
        getLogger(['app', 'lifecycle']).error('Event disposal failed: {error}', { error }),
      )
  }
  if (!response.body) {
    finish()
    return response
  }
  const reader = response.body.getReader()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (cancelled) return
        if (chunk.done) {
          reader.releaseLock()
          finish()
          controller.close()
        } else controller.enqueue(chunk.value)
      } catch (error) {
        if (cancelled) return
        reader.releaseLock()
        finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      // Cancelling resolves pending reads before the underlying cancel operation finishes.
      cancelled = true
      try {
        await reader.cancel(reason)
      } finally {
        reader.releaseLock()
        finish()
      }
    },
  })
  return new Response(body, response)
}

async function createServices(
  preparations: Map<string, ServicePreparation<unknown>>,
  resources: Readonly<Record<string, unknown>>,
  context: ServiceCreateContext,
) {
  const services: Record<string, unknown> = {}
  const factories: Record<string, ServiceBindingFactory> = {}
  for (const [name, preparation] of preparations) {
    const result = await preparation.create(resources, context)
    if (result.service !== undefined) services[name] = result.service
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
export async function createApp<D extends AppDefinition>(
  definition: D,
  ...options: EnvironmentArgs<D>
): Promise<AppInstance<D>> {
  const env = options[0]?.env
  return assembleApp(definition, {
    kind: 'static',
    config: resolveAppConfig(definition.app, env, process.env.NODE_ENV === 'production'),
    env,
  })
}
