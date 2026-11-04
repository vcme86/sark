/**
 * Business stats declaration and runtime types.
 *
 * @module
 */

export { defineStats } from '../features/stats/declaration'
export { StatsError, type StatsErrorCode } from '../features/stats/errors'
export type {
  InferStatsCounters,
  ReadResult,
  ScopedIncrementOptions,
  ScopedStatsService,
  ServiceIncrementOptions,
  StatsCounterConfig,
  StatsCountersConfig,
  StatsDeclaration,
  StatsIdentitiesConfig,
  StatsIdentityContext,
  StatsOptions,
  StatsScope,
  StatsService,
  StatsStore,
  StatsStoreContext,
  StatsStoreDeclaration,
  StatsStoreRequirements,
  StatsSubject,
  StatsUniqueBy,
  StoreInitResult,
} from '../features/stats/types'
