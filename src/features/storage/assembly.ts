/**
 * Assembly factory for named storage instances.
 *
 * @module
 */

import type { RequiresEnv, ResourceEnvironment } from '../../app/declaration'
import type { DisposalContext, ResourceAssembly } from '../../app/resource'
import type { FileStore } from './types'

/** Combined storage assembly retaining individual backend types and factory environments. */
export type StorageAssembly<T extends Record<string, ResourceAssembly<FileStore>>> =
  ResourceAssembly<{ [K in keyof T]: T[K] extends ResourceAssembly<infer R> ? R : never }> &
    ([Extract<T[keyof T], RequiresEnv<never>>] extends [never]
      ? {}
      : RequiresEnv<ResourceEnvironment<T>>)

/**
 * Assembles named stores while retaining their backend and environment types.
 *
 * @param declarations - Storage declarations keyed by application-selected names.
 * @returns A resource assembly owning Node store cleanup and resolving Workers bindings per event.
 */
export function createStorageAssembly<T extends Record<string, ResourceAssembly<FileStore>>>(
  declarations: T,
): StorageAssembly<T> {
  const entries = Object.entries(declarations)
  return {
    createStatic: async (env, context) => {
      for (const [name, decl] of entries) {
        if (decl.target === 'cloudflare' || !decl.createStatic) {
          throw new Error(`Storage "${name}" cannot be used on a Node.js host.`)
        }
      }
      const stores: Record<string, FileStore> = {}
      const disposes: Array<(ctx: DisposalContext) => Promise<void> | void> = []

      const dispose = (ctx: DisposalContext) => disposeStores(disposes, ctx)

      try {
        for (const [name, decl] of entries) {
          const result = await decl.createStatic!(env, context)
          stores[name] = result.value
          if (result.dispose) {
            disposes.push(result.dispose)
          }
        }
        return { value: stores, dispose }
      } catch (error) {
        try {
          await dispose(context)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Storage initialization and cleanup failed.',
            { cause: cleanupError },
          )
        }
        throw error
      }
    },

    createForEvent: async (env) => {
      for (const [name, decl] of entries) {
        if (decl.target === 'node' || !decl.createForEvent) {
          throw new Error(`Storage "${name}" cannot be used on a Cloudflare Workers host.`)
        }
      }
      const stores: Record<string, FileStore> = {}
      const disposes: Array<(ctx: DisposalContext) => Promise<void> | void> = []
      const dispose = (ctx: DisposalContext) => disposeStores(disposes, ctx)
      try {
        for (const [name, decl] of entries) {
          const result = await decl.createForEvent!(env)
          stores[name] = result.value
          if (result.dispose) disposes.push(result.dispose)
        }
        return { value: stores, dispose }
      } catch (error) {
        try {
          await dispose({ signal: AbortSignal.abort(error) })
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Storage initialization and cleanup failed.',
            { cause: cleanupError },
          )
        }
        throw error
      }
    },
  } as StorageAssembly<T>
}

/** Releases only the named stores created by this assembly, in reverse acquisition order. */
async function disposeStores(
  disposes: Array<(context: DisposalContext) => Promise<void> | void>,
  context: DisposalContext,
): Promise<void> {
  const errors: unknown[] = []
  while (disposes.length) {
    try {
      await disposes.pop()!(context)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Storage disposal failed.')
}
