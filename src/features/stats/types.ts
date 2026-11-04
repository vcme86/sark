/**
 * Core type contracts for named business stats and subject deduplication.
 *
 * @module
 */

import type { Logger } from '@logtape/logtape'

import type { BaseDeclaration } from '../../app/declaration'
import type { StoreContext, StoreDeclaration } from '../../app/store'

export type { StoreInitResult } from '../../app/store'

/** Deduplication subject modes supported by counters. */
export type StatsUniqueBy = 'visitor' | 'user' | 'client' | 'subject' | false

/** Individual counter configuration options. */
export interface StatsCounterConfig {
  /** Mode determining how subjects are resolved and deduplicated. */
  readonly uniqueBy: StatsUniqueBy
}

/** Record of named counters declared by an application. */
export type StatsCountersConfig = Record<string, StatsCounterConfig>

/** Stable deduplication identity comprising a category and identifier. */
export interface StatsSubject {
  /** Identity category (e.g. `'visitor'`, `'user'`, `'client'`, or application-defined). */
  readonly kind: string
  /** Stable unique identifier within the kind. */
  readonly id: string
}

/** Exact scope identifying a counter, resource key, and optional period. */
export interface StatsScope {
  /** Declared counter name. */
  readonly name: string
  /** Resource or partition key. */
  readonly key: string
  /** Non-empty period tag (e.g. `'day:2026-10-23'`), or undefined for cumulative all-time. */
  readonly period?: string
}

/** Context passed to client identity resolver functions. */
export interface StatsIdentityContext {
  /** Incoming HTTP request. */
  readonly request: Request
  /** Structured logger for diagnostics. */
  readonly logger: Logger
  /** Cancellation signal for the current request. */
  readonly signal: AbortSignal
  /** Borrowed application resources. */
  readonly resources: Readonly<Record<string, unknown>>
}

/** Custom identity resolver mappings configured on stats. */
export interface StatsIdentitiesConfig {
  /** Resolves a verified API client identifier from the current request. */
  readonly client?: (context: StatsIdentityContext) => string | null | Promise<string | null>
}

/** Finite storage requirements evaluated from counter declarations. */
export interface StatsStoreRequirements {
  /** True when at least one counter declares subject deduplication. */
  readonly unique: boolean
}

/** Environment, borrowed resources, and logging available to store declarations. */
export interface StatsStoreContext<Env = unknown> extends StoreContext<Env> {
  readonly requirements: StatsStoreRequirements
}

/** Low-level storage adapter interface for atomic increments and consistent reads. */
export interface StatsStore {
  /**
   * Atomically records a count increment and optional unique subject marker.
   *
   * Repeated subjects still increase count; storage failures must reject without partial writes.
   *
   * @param input - Counter scope and optional subject.
   * @returns Resolves after the atomic write completes.
   */
  record(input: StatsScope & { subject?: StatsSubject }): Promise<void>

  /**
   * Reads count and optional unique count from a single consistent storage snapshot.
   *
   * Empty scopes return zero. When unique is true, uniqueCount must be present.
   * Storage failures propagate instead of returning an empty result.
   *
   * @param input - Counter scope and whether unique count is requested.
   * @returns Counts from one storage snapshot.
   */
  read(input: StatsScope & { unique: boolean }): Promise<{ count: number; uniqueCount?: number }>
}

/** Delayed store declaration created once application resources are available. */
export interface StatsStoreDeclaration<Env = unknown> extends StoreDeclaration<
  StatsStore,
  Env,
  StatsStoreContext<Env>
> {}

/** Stats options passed to defineStats. */
export interface StatsOptions<TCounters extends StatsCountersConfig = StatsCountersConfig> {
  /** Delayed storage adapter declaration (e.g. sqlStats). */
  readonly store: StatsStoreDeclaration
  /** Declared business counters. */
  readonly counters: TCounters
  /** Optional custom identity resolvers. */
  readonly identities?: StatsIdentitiesConfig
}

/** Stats declaration created via defineStats. */
export interface StatsDeclaration<
  TCounters extends StatsCountersConfig = StatsCountersConfig,
> extends BaseDeclaration<'stats', StatsOptions<TCounters>> {}

/** Fully resolved stats configuration. */
export interface ResolvedStatsConfig<
  TCounters extends StatsCountersConfig = StatsCountersConfig,
> extends StatsOptions<TCounters> {
  readonly requirements: StatsStoreRequirements
}

type SubjectOptions<Mode extends StatsUniqueBy, Scoped extends boolean> = Mode extends false
  ? { readonly subject?: never }
  : Mode extends 'subject'
    ? { readonly subject: StatsSubject }
    : Scoped extends true
      ? { readonly subject?: never }
      : { readonly subject: { readonly kind: Mode; readonly id: string } }

type CounterOptions = Pick<StatsScope, 'key' | 'period'>

/** Request operations resolve automatic modes from their bound identity facilities. */
export type ScopedIncrementOptions<Counter extends StatsCounterConfig> = CounterOptions &
  SubjectOptions<Counter['uniqueBy'], true>

/** Instance and job operations require explicit subjects for every deduplicated mode. */
export type ServiceIncrementOptions<Counter extends StatsCounterConfig> = CounterOptions &
  SubjectOptions<Counter['uniqueBy'], false>

type Counts<Mode extends StatsUniqueBy> = Mode extends false
  ? { readonly count: number }
  : { readonly count: number; readonly uniqueCount: number }

/** Result shape follows the configured mode, preserving unions when the mode is dynamic. */
export type ReadResult<Counter extends StatsCounterConfig> = Counts<Counter['uniqueBy']>

/** Infers configured counters from a stats declaration or options. */
export type InferStatsCounters<T> =
  T extends StatsDeclaration<infer C>
    ? C
    : T extends StatsOptions<infer C>
      ? C
      : StatsCountersConfig

/** Request-scoped stats service accessible via ctx.var.stats. */
export interface ScopedStatsService<TCounters extends StatsCountersConfig = StatsCountersConfig> {
  /**
   * Increments one period, resolving automatic modes from the current request.
   * Repeated subjects still increase count; missing identities cause no writes.
   *
   * @param name - Declared counter name.
   * @param options - Resource key, optional period, and subject when required by the counter.
   * @returns Resolves after persistence completes.
   * @throws If scope or subject is invalid, an identity is missing, or storage fails.
   */
  increment<K extends keyof TCounters & string>(
    name: K,
    options: ScopedIncrementOptions<TCounters[K]>,
  ): Promise<void>
  /**
   * Reads counts without resolving or creating a request identity.
   *
   * @param name - Declared counter name.
   * @param options - Exact resource key and optional period.
   * @returns Counts, including uniqueCount only for deduplicated counters; empty scopes return zero.
   * @throws If the scope is invalid or storage fails.
   */
  read<K extends keyof TCounters & string>(
    name: K,
    options: { readonly key: string; readonly period?: string },
  ): Promise<ReadResult<TCounters[K]>>
}

/** Application-level and JobContext stats service accessible via instance.stats and JobContext.stats. */
export interface StatsService<TCounters extends StatsCountersConfig = StatsCountersConfig> {
  /**
   * Increments one period without borrowing an HTTP request identity.
   * Deduplicated counters require an explicit subject; repeated subjects still increase count.
   *
   * @param name - Declared counter name.
   * @param options - Resource key, optional period, and an explicit subject for deduplicated counters.
   * @returns Resolves after persistence completes.
   * @throws If scope or subject is invalid, or storage fails.
   */
  increment<K extends keyof TCounters & string>(
    name: K,
    options: ServiceIncrementOptions<TCounters[K]>,
  ): Promise<void>
  /**
   * Reads the exact scope without filtering by an individual subject.
   *
   * @param name - Declared counter name.
   * @param options - Exact resource key and optional period.
   * @returns Counts, including uniqueCount only for deduplicated counters; empty scopes return zero.
   * @throws If the scope is invalid or storage fails.
   */
  read<K extends keyof TCounters & string>(
    name: K,
    options: { readonly key: string; readonly period?: string },
  ): Promise<ReadResult<TCounters[K]>>
}
