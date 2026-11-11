/** Page cache service preparation and instance/event work ownership. */
import type { EnvironmentRequirement } from '../../app/declaration'
import type {
  RequestBindingContext,
  ServiceAssembly,
  ServiceCreateContext,
  ServiceRuntime,
} from '../../app/service'
import { type PageCacheDeclaration, type PageCacheService, resolvePageCacheOptions } from '../cache'
import { type CacheWork, PageCacheStorage } from './cache'

/** Internal handle pairing shared storage with the initiating event's work owner. */
export interface PageCacheRuntime extends PageCacheService {
  readonly storage: PageCacheStorage
  readonly work: CacheWork
}

/**
 * Declares cache preparation with independent state for each application runtime.
 *
 * @param declaration - Capacity and default TTL settings resolved by the owning preparation.
 * @returns A service exposing invalidation only when pageCache is selected.
 */
export function createPageCacheAssembly<T extends PageCacheDeclaration>(
  declaration: T,
): ServiceAssembly<PageCacheService> & EnvironmentRequirement<readonly [T]>
export function createPageCacheAssembly(
  declaration: PageCacheDeclaration,
): ServiceAssembly<PageCacheService> {
  return { expose: true, createRuntime: () => createCacheRuntime(declaration) }
}

/** Owns isolate storage without retaining any event's resources or execution context. */
function createCacheRuntime(declaration: PageCacheDeclaration): ServiceRuntime<PageCacheService> {
  let storage: PageCacheStorage | undefined
  let configuration: string | undefined
  let staticOptions: ReturnType<typeof resolvePageCacheOptions> | undefined
  return {
    prepare(env) {
      const options = declaration.isFactory
        ? resolvePageCacheOptions(declaration, env)
        : (staticOptions ??= resolvePageCacheOptions(declaration, env))
      const key = declaration.isFactory ? JSON.stringify(options) : ''
      if (!storage || key !== configuration) {
        storage?.clear()
        storage = new PageCacheStorage(options)
        configuration = key
      }
      // Preserve this preparation if another event reconfigures storage while resources are opening.
      const current = storage
      return { create: (_resources, context) => bindCacheService(current, context) }
    },
  }
}

/** Retains event resources through tracked work; only a Node instance owns storage disposal. */
function bindCacheService(storage: PageCacheStorage, context: ServiceCreateContext) {
  if (context.target === 'node') context.registerDispose('pageCache', () => storage.clear())
  const service: PageCacheRuntime = {
    storage,
    work: { signal: context.backgroundSignal, waitUntil: context.waitUntil },
    revalidatePath: (path) => storage.revalidatePath(path),
    revalidateTag: (tag) => storage.revalidateTag(tag),
  }
  return {
    service,
    createBinding({ ctx }: RequestBindingContext) {
      ctx.set('cache', service)
      return {}
    },
  }
}
