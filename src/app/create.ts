/**
 * Application instance creation, request dispatch, and lifecycle integration.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { getLogger } from '@logtape/logtape'
import type { Hono } from 'hono'

import { resolveAppConfig, type ResolvedHttpConfig } from './config'
import {
  applicationRoutes,
  type ExecutionScope,
  getCurrentScope,
  runInScope,
  runWithoutScope,
} from './context'
import type { EnvironmentArgs } from './declaration'
import type { AppDefinition } from './definition'
import type { RouteEntry } from './http/assembly'
import { requestDeliveries, trackResponseCompletion } from './http/delivery'
import { formatErrorResponse } from './http/output'
import { buildHttpApp } from './http/pipeline'
import { applyResponseHeaders, responseMetadata } from './http/request-context'
import { getWsUpgradeState } from './http/websocket'
import { applicationLifecycles, LifecycleManager } from './lifecycle'
import { applicationLogging, ensureBasicLogging, type ExecutionLogging } from './logging'
import type { ServiceBindingFactory, ServiceCreateContext, ServicePreparation } from './service'
import type { AppInstance } from './types'

/** Internal symbol for dispatching scheduled platform events within assembled event context. */
export const kInternalDispatchEvent = Symbol.for('sark.dispatchEvent')

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

    const admissionRuntime = definition.admission?.()
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
      const admission = admissionRuntime?.prepare(
        env,
        routes,
        options.kind === 'static' ? 'node' : 'cloudflare',
      )
      return { preparations, routes, admission }
    }

    const staticPlan =
      options.kind === 'static' ? await prepareServices(options.env, options.config) : undefined

    if (options.kind === 'event' && definition.assetMounts) {
      throw new Error('Runtime directory mounts are not supported on Cloudflare Workers.')
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
            definition.page404Handler,
            definition.webPrefix,
            staticAssetMountHandler,
            staticPlan!.admission ? () => staticPlan!.admission! : undefined,
          )
        : undefined
    let cachedEventHonoApp: Hono<any> | undefined
    let cachedEventRoutes: readonly RouteEntry[] | undefined

    const appResources = {
      ...(definition.logging ? { logging: definition.logging } : {}),
      ...definition.resources,
    }

    const staticResources: Record<string, unknown> = {}
    const assembledResources = Object.entries(appResources)

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
    const readyCallbacks: Array<
      (readyContext: import('./service').ServiceReadyContext) => void | Promise<void>
    > = []
    const staticServices = staticPlan
      ? await createServices(staticPlan.preparations, staticResources, {
          env: staticEnv,
          target: 'node',
          resourceDeclarations: definition.resources ?? {},
          logger,
          waitUntil: trackStaticWork,
          signal: lifecycle.signal,
          drainingSignal: lifecycle.drainingSignal,
          shutdown: lifecycle.shutdown,
          onReady: (cb) => readyCallbacks.push(cb),
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

    interface EventScopeContext {
      readonly resources: Readonly<Record<string, unknown>>
      readonly services: Readonly<Record<string, unknown>>
      readonly serviceBindingFactories: Readonly<Record<string, ServiceBindingFactory>>
      readonly effectiveConfig: ResolvedHttpConfig
      readonly httpApp?: Hono<any>
      readonly admission?: import('./http/assembly').RouteAdmission
      readonly cleanup: () => Promise<void>
    }

    async function prepareEventScope(
      eventEnv: unknown,
      executionCtx: unknown,
      signal: AbortSignal,
      compileHttpApp = false,
    ): Promise<EventScopeContext> {
      const effectiveConfig = options.kind === 'event' ? options.resolve(eventEnv) : options.config
      const eventPlan = await prepareServices(eventEnv, effectiveConfig)
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
      const cleanup = async () => {
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
        let httpApp: Hono<any> | undefined
        if (compileHttpApp) {
          const routes = eventPlan.routes
          if (
            !cachedEventRoutes ||
            routes.length !== cachedEventRoutes.length ||
            routes.some((route, index) => route !== cachedEventRoutes![index])
          ) {
            cachedEventHonoApp = buildHttpApp(
              currentConfig,
              [...routes],
              () => instance,
              definition.page404Handler,
              definition.webPrefix,
              undefined,
              admissionRuntime ? () => getCurrentScope()!.admission! : undefined,
            )
            cachedEventRoutes = routes
          }
          httpApp = cachedEventHonoApp!
        }

        const resources: Record<string, unknown> = {}
        for (const [name, res] of assembledResources) {
          const resResult = await res.createForEvent!(eventEnv)
          resources[name] = resResult.value
          if (resResult.dispose) eventDisposals.push(() => resResult.dispose!({ signal }))
        }

        const eventServices = await createServices(eventPlan.preparations, resources, {
          env: eventEnv,
          target: 'cloudflare',
          resourceDeclarations: definition.resources ?? {},
          logger,
          waitUntil: trackEventWork,
          signal,
          registerDispose: (_name, dispose) => {
            eventDisposals.push(() => dispose({ signal }))
          },
        })

        return {
          resources,
          services: eventServices.services,
          serviceBindingFactories: eventServices.factories,
          effectiveConfig,
          admission: eventPlan.admission,
          httpApp,
          cleanup,
        }
      } catch (initErr) {
        let err = initErr
        try {
          await cleanup()
        } catch (cleanupErr) {
          err = new AggregateError([err, cleanupErr], 'Event initialization and disposal failed.')
        }
        throw err
      }
    }

    /** Keeps event cleanup inside the logging scope, including initialization failures. */
    async function runEventScope<T>(event: EventScopeContext, fn: () => Promise<T>): Promise<T> {
      let entered = false
      const execute = async () => {
        entered = true
        let result: T
        try {
          result = await fn()
        } catch (error) {
          try {
            await event.cleanup()
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Event execution and cleanup failed.', {
              cause: cleanupError,
            })
          }
          throw error
        }
        await event.cleanup()
        return result
      }
      const logging = event.resources.logging as ExecutionLogging | undefined
      try {
        return await (logging?.withScope ? logging.withScope(execute) : execute())
      } catch (error) {
        // A scoped LogTape configuration can fail before it invokes execute.
        if (!entered) {
          try {
            await event.cleanup()
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Event setup and cleanup failed.', {
              cause: cleanupError,
            })
          }
        }
        throw error
      }
    }

    const executeTracked = async (
      request: Request,
      requestEnv?: unknown,
      executionCtx?: unknown,
    ): Promise<Response> => {
      const requestStartTime = performance.now()
      lifecycle.beginRequest()
      const parent = getCurrentScope()
      const isInternal = parent?.app === instance && parent?.isInternal === true
      const requestId =
        (isInternal ? parent.requestId : undefined) ||
        (executionCtx ? request.headers.get('cf-ray') : undefined) ||
        crypto.randomUUID()
      let effectiveConfig: ResolvedHttpConfig | undefined
      let eventScope: EventScopeContext | undefined

      function errorResponse(error: unknown): Response {
        const config =
          effectiveConfig ?? (options.kind === 'static' ? options.config : options.errorConfig)
        const response = runInScope({ requestId, app: instance }, () =>
          formatErrorResponse(error, config.production),
        )
        return applyResponseHeaders(
          request.method === 'HEAD' ? new Response(null, response) : response,
          config,
          requestId,
        )
      }

      try {
        let currentResources: Readonly<Record<string, unknown>>
        let currentServices: Readonly<Record<string, unknown>>
        let currentBindingFactories: Readonly<Record<string, ServiceBindingFactory>>
        let activeApp = isInternal ? parent.httpApp! : staticHonoApp

        if (isInternal) {
          effectiveConfig = currentConfig()
          currentResources = parent.resources!
          currentServices = parent.services!
          currentBindingFactories = parent.serviceBindingFactories!
        } else if (options.kind === 'event') {
          eventScope = await prepareEventScope(requestEnv, executionCtx, request.signal, true)
          effectiveConfig = eventScope.effectiveConfig
          currentResources = eventScope.resources
          currentServices = eventScope.services
          currentBindingFactories = eventScope.serviceBindingFactories
          activeApp = eventScope.httpApp!
        } else {
          effectiveConfig = options.config
          currentResources = staticResources
          currentServices = staticServices!.services
          currentBindingFactories = staticServices!.factories
        }

        const pageConfig = isInternal
          ? parent.pageConfig
          : options.kind === 'static'
            ? staticPageConfig
            : resolvePageConfig?.(requestEnv)
        const currentAdmission = isInternal
          ? parent.admission
          : (eventScope?.admission ?? staticPlan?.admission)
        const logging = currentResources.logging as ExecutionLogging | undefined
        const shouldLogAccess = !isInternal && logging?.recordAccess !== undefined

        const dispatch = async (finishEvent?: () => Promise<void>): Promise<Response> => {
          const requestScope: ExecutionScope = {
            ...parent,
            requestId,
            app: instance,
            config: effectiveConfig,
            pageConfig,
            admission: currentAdmission,
            resources: currentResources,
            services: currentServices,
            serviceBindingFactories: currentBindingFactories,
            serviceBindings: isInternal ? parent.serviceBindings : undefined,
            httpApp: activeApp,
            env: options.kind === 'event' ? requestEnv : options.env,
            executionCtx,
          }
          let response: Response
          try {
            response = await runInScope(requestScope, () =>
              activeApp!.fetch(request, requestEnv, executionCtx as any),
            )
          } catch (error) {
            response = errorResponse(error)
          }

          const upgrade = getWsUpgradeState(response)
          const meta = responseMetadata.get(response)
          const recordAccess = (
            outcome: 'ok' | 'error' | 'aborted',
            status: number | undefined,
          ) => {
            if (shouldLogAccess)
              logging!.recordAccess!(
                {
                  method: request.method,
                  url: request.url,
                  requestId: meta?.requestId || response.headers.get('x-request-id') || requestId,
                  clientIp: meta?.clientIp || '127.0.0.1',
                },
                status,
                performance.now() - requestStartTime,
                outcome,
              )
          }
          if (upgrade) {
            let recorded = false
            upgrade.complete = AsyncLocalStorage.bind((status, outcome) => {
              if (recorded) return
              recorded = true
              recordAccess(outcome, status)
            })
            lifecycle.beginRequest()
            let released: Promise<void> | undefined
            upgrade.release = AsyncLocalStorage.bind(
              () =>
                (released ??= (async () => {
                  try {
                    upgrade.complete?.(undefined, 'aborted')
                    await finishEvent?.()
                  } finally {
                    lifecycle.endRequest()
                  }
                })()),
            )
            return response
          }
          const delivery = !isInternal ? requestDeliveries.get(request) : undefined
          if (delivery) {
            lifecycle.beginRequest()
            void delivery
              .then(
                AsyncLocalStorage.bind(async ({ outcome, status }) => {
                  try {
                    recordAccess(outcome, status)
                    await finishEvent?.()
                  } finally {
                    lifecycle.endRequest()
                  }
                }),
              )
              .catch((error) => logger.error('Delivery completion failed: {error}', { error }))
            return response
          }
          if (!shouldLogAccess && !finishEvent) return response
          return runInScope(meta?.scope ?? requestScope, () =>
            trackResponseCompletion(response, (outcome) => {
              recordAccess(outcome, response.status)
              void finishEvent?.()
            }),
          )
        }

        if (!eventScope) return await dispatch()

        const event = eventScope
        eventScope = undefined // runEventScope now owns all cleanup, including setup failure.
        const ready = Promise.withResolvers<Response>()
        const completed = Promise.withResolvers<void>()
        let lifetime: Promise<void>
        lifetime = runEventScope(event, async () => {
          ready.resolve(
            await dispatch(() => {
              completed.resolve()
              return lifetime
            }),
          )
          await completed.promise
        })
        const host = executionCtx as { waitUntil(work: Promise<unknown>): void } | undefined
        // Register the whole lifetime before returning; it includes LogTape async disposal.
        if (host) host.waitUntil(lifetime)
        else
          void lifetime.catch((error) => logger.error('Event disposal failed: {error}', { error }))
        void lifetime.catch(ready.reject)
        return await ready.promise
      } catch (failure) {
        let error = failure
        if (eventScope) {
          try {
            await eventScope.cleanup()
          } catch (cleanupError) {
            error = new AggregateError(
              [error, cleanupError],
              'Event execution and cleanup failed.',
              { cause: cleanupError },
            )
          }
        }
        return errorResponse(error)
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
      [kInternalDispatchEvent]:
        options.kind === 'event'
          ? async <T>(
              eventEnv: unknown,
              executionCtx: unknown,
              fn: () => Promise<T>,
            ): Promise<T> => {
              lifecycle.beginRequest()
              try {
                const event = await prepareEventScope(eventEnv, executionCtx, lifecycle.signal)
                return await runEventScope(event, () =>
                  runInScope(
                    {
                      app: instance,
                      requestId: crypto.randomUUID(),
                      config: event.effectiveConfig,
                      admission: event.admission,
                      resources: event.resources,
                      services: event.services,
                      serviceBindingFactories: event.serviceBindingFactories,
                      env: eventEnv,
                      executionCtx,
                      signal: lifecycle.signal,
                    },
                    fn,
                  ),
                )
              } finally {
                lifecycle.endRequest()
              }
            }
          : undefined,
    } as unknown as AppInstance<D>

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

    if (staticResources.logging)
      applicationLogging.set(instance, staticResources.logging as ExecutionLogging)
    applicationLifecycles.set(instance, lifecycle)
    if (staticHonoApp) applicationRoutes.set(instance, staticHonoApp.routes)

    lifecycle.setReady()
    const readyContext = {
      app: instance,
      services: staticServices?.services ?? {},
    }
    for (const cb of readyCallbacks) {
      await cb(readyContext)
    }

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

/**
 * Runs selected platform work inside the application's event resources and logging scope.
 *
 * @param instance - Event-host application created from the same generated definition.
 * @param env - Bindings for this platform event, retained by its internal calls.
 * @param context - Platform lifetime owner, including waitUntil.
 * @param execute - Domain work executed after event preparation.
 * @returns The work result after tracked work and event cleanup have settled.
 */
export function dispatchApplicationEvent<T>(
  instance: AppInstance<any>,
  env: unknown,
  context: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  return (
    instance as AppInstance<any> & {
      [kInternalDispatchEvent]: (env: unknown, context: unknown, fn: () => Promise<T>) => Promise<T>
    }
  )[kInternalDispatchEvent](env, context, execute)
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
