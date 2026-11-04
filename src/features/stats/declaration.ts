/**
 * Declarations and configuration resolution for application stats.
 *
 * @module
 */

import { evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import { validateStoreDeclaration } from '../../app/store'
import { StatsError } from './errors'
import type {
  ResolvedStatsConfig,
  StatsCountersConfig,
  StatsDeclaration,
  StatsOptions,
  StatsUniqueBy,
} from './types'

const VALID_UNIQUE_BY = new Set<StatsUniqueBy>([false, 'visitor', 'user', 'client', 'subject'])

/**
 * Declares stats settings resolved from the environment.
 *
 * @param factory - Configuration factory evaluated during assembly.
 * @returns A declaration preserving the factory's environment requirements.
 */
export function defineStats<const TCounters extends StatsCountersConfig, E>(
  factory: (env: E) => StatsOptions<TCounters>,
): StatsDeclaration<TCounters> & RequiresEnv<E>
/**
 * Declares named business counters, storage adapter, and identity mappings.
 *
 * @param config - Static stats options.
 * @returns A declaration evaluated when assembling the stats service.
 */
export function defineStats<const TCounters extends StatsCountersConfig>(
  config: StatsOptions<TCounters>,
): StatsDeclaration<TCounters>
export function defineStats<const TCounters extends StatsCountersConfig, E>(
  input: StatsOptions<TCounters> | ((env: E) => StatsOptions<TCounters>),
): StatsDeclaration<TCounters> {
  return {
    kind: 'stats',
    value: input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves and validates stats options against the environment.
 *
 * @param declaration - Declared stats configuration or factory.
 * @param env - Loaded environment.
 * @returns Fully validated and resolved stats configuration.
 */
export function resolveStatsConfig<TCounters extends StatsCountersConfig>(
  declaration: StatsDeclaration<TCounters>,
  env: unknown,
): ResolvedStatsConfig<TCounters> {
  const raw = evaluateDeclaration<StatsOptions<TCounters>>(declaration.value, env, 'stats')

  validateStatsOptions(raw)

  return {
    store: raw.store,
    counters: Object.fromEntries(
      Object.entries(raw.counters).map(([name, counter]) => [name, { uniqueBy: counter.uniqueBy }]),
    ) as TCounters,
    identities: raw.identities,
    requirements: {
      unique: Object.values(raw.counters).some((counter) => counter.uniqueBy !== false),
    },
  }
}

function validateStatsOptions(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StatsError('stats_config_error', 'Stats configuration must be an object.')
  }

  const options = raw as Partial<StatsOptions<StatsCountersConfig>>

  validateStoreDeclaration(options.store, 'Stats')

  if (
    !options.counters ||
    typeof options.counters !== 'object' ||
    Array.isArray(options.counters) ||
    Object.keys(options.counters).length === 0
  ) {
    throw new StatsError(
      'stats_config_error',
      'Stats requires at least one configured counter mapping.',
    )
  }

  for (const [name, counter] of Object.entries(options.counters)) {
    if (name.length === 0 || name.includes('\0')) {
      throw new StatsError(
        'stats_config_error',
        `Invalid counter name "${name}". Counter names must be non-empty strings without null bytes.`,
      )
    }

    if (!counter || typeof counter !== 'object' || Array.isArray(counter)) {
      throw new StatsError(
        'stats_config_error',
        `Counter "${name}" configuration must be an object.`,
      )
    }

    if (!VALID_UNIQUE_BY.has(counter.uniqueBy)) {
      throw new StatsError(
        'stats_config_error',
        `Counter "${name}" has invalid uniqueBy "${String(counter.uniqueBy)}".`,
      )
    }

    if (counter.uniqueBy === 'client' && typeof options.identities?.client !== 'function') {
      throw new StatsError(
        'stats_config_error',
        `Counter "${name}" declared uniqueBy "client", but identities.client is not configured.`,
      )
    }
  }
}
