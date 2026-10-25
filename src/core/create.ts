/**
 * Application instance creation, request dispatch, and lifecycle integration.
 *
 * @module
 */

import { buildHttpApp } from '../web/http/server/pipeline'
import { resolveAppConfig } from './config'
import { getCurrentScope, runInScope, runWithoutScope } from './context'
import type { EnvironmentArgs } from './declaration'
import type { ApplicationDefinition } from './definition'
import { applicationLifecycles, LifecycleManager } from './lifecycle'
import { ensureBasicLogging } from './logging'
import type { AppInstance } from './types'

/**
 * Resolves application configuration and creates an instance ready for requests.
 * Factory declarations require an environment. Initialization failure disposes
 * registered resources before propagating the error.
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
  ensureBasicLogging()
  const lifecycle = new LifecycleManager()
  const env = options[0]?.env

  try {
    const resolvedConfig = resolveAppConfig(
      definition.appDeclaration,
      env,
      process.env.NODE_ENV === 'production',
    )

    let instanceRef: AppInstance<D> | undefined
    const honoApp = buildHttpApp(resolvedConfig, definition.routes, () => instanceRef)

    lifecycle.setReady()

    // Tracks handler completion; the Node host separately waits for response streams.
    const executeTracked = async (request: Request, requestEnv?: unknown): Promise<Response> => {
      lifecycle.beginRequest()
      try {
        const parent = getCurrentScope()
        return await runInScope(
          {
            ...parent,
            requestId: parent?.isInternal ? parent.requestId : crypto.randomUUID(),
            app: instanceRef,
            config: resolvedConfig,
            env,
          },
          () => honoApp.fetch(request, requestEnv),
        )
      } finally {
        lifecycle.endRequest()
      }
    }

    const instance: AppInstance<D> = {
      definition,
      config: resolvedConfig,
      hono: honoApp,
      get state() {
        return lifecycle.state
      },
      fetch(request, requestEnv?: unknown) {
        return runWithoutScope(() => executeTracked(request, requestEnv))
      },
      fetchInternal(request) {
        const parent = getCurrentScope()
        if (parent?.app !== instance) return instance.fetch(request)
        const internalRequest = parent.signal
          ? new Request(request, { signal: AbortSignal.any([parent.signal, request.signal]) })
          : request
        return runInScope({ ...parent, isInternal: true }, async () => {
          const response = await executeTracked(internalRequest)
          parent.appendCookies?.(response.headers.getSetCookie())
          return response
        })
      },
      close(): Promise<void> {
        return lifecycle.close()
      },
    }

    applicationLifecycles.set(instance, lifecycle)
    instanceRef = instance
    return instance
  } catch (err) {
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
