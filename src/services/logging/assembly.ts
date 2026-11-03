/** Logging configuration preparation and platform-owned sink lifetimes. */
import { type Config, configure, drain, reset, type Sink, withConfig } from '@logtape/logtape'

import {
  acquireLoggingOwnership,
  commitLoggingOwnership,
  ensureBasicLogging,
  releaseLoggingOwnership,
  sarkContextLocalStorage,
} from '../../core/logging'
import type { ResourceAssembly } from '../../core/resource'
import { resolveLoggingConfig } from './declaration'
import type { LoggingDeclaration, ResolvedLoggingConfig } from './types'

/** Logging facilities owned by an application or a single platform event. */
export interface LoggingRuntime {
  readonly isAccessLogEnabled: boolean
  readonly redactFields: readonly string[]
  /** Resolves after the callback and all scoped LogTape sinks have finished. */
  withScope?<R>(fn: () => Promise<R>): Promise<R>
}

/**
 * Creates logging resources without allocating sinks during declaration.
 * Node owns the global configuration; Workers events use upstream scoped configuration.
 *
 * @param declaration - Logging settings or environment factory.
 * @returns Assembly creating and releasing only its own sinks.
 */
export function createLoggingAssembly(
  declaration: LoggingDeclaration,
): ResourceAssembly<LoggingRuntime> {
  const owner = {}
  return {
    async createStatic(env) {
      acquireLoggingOwnership(owner)
      let resolved: ResolvedLoggingConfig
      let prepared: Awaited<ReturnType<typeof prepareLogging>> | undefined
      try {
        resolved = resolveLoggingConfig(declaration, env)
        prepared = await prepareLogging(resolved)
        acquireLoggingOwnership(owner)
        await configure({
          ...prepared.config,
          contextLocalStorage: sarkContextLocalStorage,
          reset: true,
        })
        commitLoggingOwnership(owner, resolved.redact)
      } catch (error) {
        releaseLoggingOwnership(owner)
        if (prepared) await rollbackSinks(prepared.sinks, error)
        throw error
      }
      return {
        value: { isAccessLogEnabled: resolved.accessEnabled, redactFields: resolved.redact },
        async dispose() {
          const errors: unknown[] = []
          try {
            await drain()
          } catch (error) {
            errors.push(error)
          }
          try {
            await reset()
          } catch (error) {
            errors.push(error)
          }
          releaseLoggingOwnership(owner)
          ensureBasicLogging()
          if (errors.length) throw new AggregateError(errors, 'Logging sinks disposal failed.')
        },
      }
    },
    async createForEvent(env) {
      const resolved = resolveLoggingConfig(declaration, env)
      const prepared = await prepareLogging(resolved)
      let transferred = false
      return {
        value: {
          isAccessLogEnabled: resolved.accessEnabled,
          redactFields: resolved.redact,
          withScope<R>(fn: () => Promise<R>): Promise<R> {
            return withConfig(prepared.config, () => {
              // LogTape owns disposal only after scoped configuration has succeeded.
              transferred = true
              return fn()
            })
          },
        },
        async dispose() {
          if (!transferred) await disposeSinks(prepared.sinks)
        },
      }
    },
  }
}

/** Creates sinks once and prepares the same routing policy for both hosts. */
async function prepareLogging(
  resolved: ResolvedLoggingConfig,
): Promise<{ config: Config<string, string>; sinks: Sink[] }> {
  const sinks: Record<string, Sink> = {}
  const created: Sink[] = []
  try {
    for (const [name, factory] of Object.entries(resolved.sinks)) {
      const sink = await factory()
      sinks[name] = sink
      created.push(sink)
    }
  } catch (error) {
    await rollbackSinks(created, error)
  }
  const loggers: NonNullable<Config<string, string>['loggers']> = [
    {
      category: ['app'],
      lowestLevel: resolved.level,
      sinks: [...resolved.categories.app],
    },
  ]
  for (const [category, targets] of Object.entries(resolved.categories)) {
    if (category !== 'app')
      loggers.push({
        category: ['app', category],
        lowestLevel: resolved.level,
        sinks: [...targets],
        parentSinks: 'override',
      })
  }
  if (resolved.accessEnabled)
    loggers.push({
      category: ['sark', 'access'],
      lowestLevel: 'info',
      sinks: [...resolved.accessSinks],
      parentSinks: 'override',
    })
  // LogTape disposes in insertion order; registration is reversed to release dependencies last.
  return {
    config: { sinks: Object.fromEntries(Object.entries(sinks).toReversed()), loggers },
    sinks: created,
  }
}

/** Releases untransferred sinks in reverse creation order, retaining every failure. */
async function disposeSinks(sinks: readonly Sink[]): Promise<void> {
  const errors: unknown[] = []
  for (const sink of sinks.toReversed()) {
    try {
      if (Symbol.asyncDispose in sink) await (sink as Sink & AsyncDisposable)[Symbol.asyncDispose]()
      else if (Symbol.dispose in sink) (sink as Sink & Disposable)[Symbol.dispose]()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Logging sinks disposal failed.')
}

async function rollbackSinks(sinks: readonly Sink[], failure: unknown): Promise<never> {
  try {
    await disposeSinks(sinks)
  } catch (cleanupError) {
    throw new AggregateError([failure, cleanupError], 'Logging setup and rollback failed.', {
      cause: cleanupError,
    })
  }
  throw failure
}
