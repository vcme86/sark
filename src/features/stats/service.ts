/** Shared counter operations with explicit or request-bound subject resolution. */
import type { Logger } from '@logtape/logtape'

import type { RequestBindingContext } from '../../app/service'
import type { RequestAuth } from '../auth/session/types'
import type { RequestVisitor } from '../visitors/types'
import { StatsError } from './errors'
import type {
  ResolvedStatsConfig,
  ScopedStatsService,
  StatsCounterConfig,
  StatsCountersConfig,
  StatsScope,
  StatsService,
  StatsStore,
  StatsSubject,
} from './types'

interface RequestStatsContext {
  readonly binding: RequestBindingContext
  readonly resources: Readonly<Record<string, unknown>>
  readonly logger: Logger
}

/** Binds shared operations to explicit subjects or the current request identity sources. */
export function createStatsService<C extends StatsCountersConfig>(
  store: StatsStore,
  config: ResolvedStatsConfig<C>,
): StatsService<C>
export function createStatsService<C extends StatsCountersConfig>(
  store: StatsStore,
  config: ResolvedStatsConfig<C>,
  request: RequestStatsContext,
): ScopedStatsService<C>
export function createStatsService(
  store: StatsStore,
  config: ResolvedStatsConfig,
  request?: RequestStatsContext,
): StatsService | ScopedStatsService {
  return {
    async increment(
      name: string,
      options: { key: string; period?: string; subject?: StatsSubject },
    ) {
      const counter = getCounter(config, name)
      const scope = resolveScope(name, options)
      const subject = request
        ? await requestSubject(counter, options.subject, config, request)
        : explicitSubject(counter, options.subject)
      await store.record({ ...scope, subject })
    },
    async read(name: string, options: { key: string; period?: string }) {
      const counter = getCounter(config, name)
      // Store implementations own empty-range results; missing fields are never repaired here.
      return store.read({ ...resolveScope(name, options), unique: counter.uniqueBy !== false })
    },
  } as StatsService | ScopedStatsService
}

function getCounter(config: ResolvedStatsConfig, name: string): StatsCounterConfig {
  if (!Object.hasOwn(config.counters, name))
    throw new StatsError('stats_counter_unknown', `Unknown counter "${name}".`)
  return config.counters[name]
}

function resolveScope(name: string, options: { key: string; period?: string }): StatsScope {
  if (typeof options.key !== 'string' || options.key.length === 0 || options.key.includes('\0')) {
    throw new StatsError(
      'stats_key_invalid',
      'Counter key must be a non-empty string without null bytes.',
    )
  }
  if (
    options.period !== undefined &&
    (typeof options.period !== 'string' ||
      options.period.length === 0 ||
      options.period.includes('\0'))
  ) {
    throw new StatsError(
      'stats_period_invalid',
      'Explicit period must be a non-empty string without null bytes.',
    )
  }
  return { name, key: options.key, period: options.period }
}

function explicitSubject(
  counter: StatsCounterConfig,
  subject: StatsSubject | undefined,
): StatsSubject | undefined {
  if (counter.uniqueBy === false) {
    rejectSubjectOverride(subject)
    return undefined
  }
  if (
    !subject ||
    typeof subject.kind !== 'string' ||
    !subject.kind ||
    typeof subject.id !== 'string' ||
    !subject.id
  ) {
    throw new StatsError(
      'stats_subject_missing',
      'This counter requires an explicit subject with non-empty kind and id.',
    )
  }
  if (counter.uniqueBy !== 'subject' && subject.kind !== counter.uniqueBy) {
    throw new StatsError(
      'stats_subject_invalid',
      `Expected subject kind "${counter.uniqueBy}", got "${subject.kind}".`,
    )
  }
  return { kind: subject.kind, id: subject.id }
}

/** Resolves identity at the operation, so sign-in, sign-out and visitor changes remain visible. */
async function requestSubject(
  counter: StatsCounterConfig,
  subject: StatsSubject | undefined,
  config: ResolvedStatsConfig,
  request: RequestStatsContext,
): Promise<StatsSubject | undefined> {
  if (counter.uniqueBy === false || counter.uniqueBy === 'subject')
    return explicitSubject(counter, subject)
  rejectSubjectOverride(subject)
  const { binding } = request
  let id: string | null | undefined
  switch (counter.uniqueBy) {
    case 'visitor':
      id = (binding.ctx.get('visitor') as RequestVisitor).id
      break
    case 'user':
      id = (binding.ctx.get('auth') as RequestAuth).identity?.sub
      break
    case 'client':
      id = await config.identities!.client!({
        request: binding.request,
        signal: binding.signal,
        resources: request.resources,
        logger: request.logger,
      })
      break
  }
  if (typeof id !== 'string' || !id)
    throw new StatsError(
      'stats_subject_missing',
      `No ${counter.uniqueBy} subject is available for this request.`,
    )
  return { kind: counter.uniqueBy, id }
}

function rejectSubjectOverride(subject: StatsSubject | undefined): void {
  if (subject !== undefined)
    throw new StatsError(
      'stats_subject_invalid',
      'This counter does not accept an explicit subject.',
    )
}
