/** Logging configuration preparation and platform-owned sink lifetimes. */
import {
  type Config,
  configure,
  drain,
  getConsoleSink,
  jsonLinesFormatter,
  reset,
  type Sink,
  withConfig,
} from '@logtape/logtape'

import {
  acquireLoggingOwnership,
  commitLoggingOwnership,
  ensureBasicLogging,
  type ExecutionLogging,
  redactSink,
  releaseLoggingOwnership,
  sarkContextLocalStorage,
} from '../../app/logging'
import type { ResourceAssembly } from '../../app/resource'
import { emitAccessLog } from './access'
import { resolveLoggingConfig } from './declaration'
import type { LoggingDeclaration, ResolvedLoggingConfig } from './types'

/**
 * Creates logging resources without allocating sinks during declaration.
 * Node owns the global configuration; Workers events use upstream scoped configuration.
 *
 * @param declaration - Logging settings or environment factory.
 * @returns Assembly creating and releasing only its own sinks.
 */
export function createLoggingAssembly(
  declaration: LoggingDeclaration,
): ResourceAssembly<ExecutionLogging> {
  return {
    async createStatic(env) {
      const owner = {}
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
        commitLoggingOwnership(owner)
      } catch (error) {
        releaseLoggingOwnership(owner)
        if (prepared) await rollbackSinks(prepared.sinks, error)
        throw error
      }
      return {
        value: { recordAccess: resolved.accessEnabled ? emitAccessLog : undefined },
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
      const resolved = resolveLoggingConfig(declaration, env, () =>
        getConsoleSink({ formatter: jsonLinesFormatter }),
      )
      const prepared = await prepareLogging(resolved)
      let transferred = false
      return {
        value: {
          recordAccess: resolved.accessEnabled ? emitAccessLog : undefined,
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
      const sink = redactSink(await factory(), resolved.redact)
      sinks[name] = sink
      created.push(sink)
    }
  } catch (error) {
    await rollbackSinks(created, error)
  }
  const loggers: NonNullable<Config<string, string>['loggers']> = [
    {
      category: ['logtape', 'meta'],
      lowestLevel: 'warning',
      sinks: ['console'],
    },
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
