/** Stats configuration preparation and instance/event-owned store assembly. */
import type { EnvironmentRequirement } from '../../app/declaration'
import type {
  ServiceAssembly,
  ServiceCreateContext,
  ServiceInitResult,
  ServiceRuntime,
} from '../../app/service'
import { initializeStore } from '../../app/store'
import { resolveStatsConfig } from './declaration'
import { StatsError } from './errors'
import { createStatsService } from './service'
import type {
  InferStatsCounters,
  ResolvedStatsConfig,
  StatsDeclaration,
  StatsService,
} from './types'

/** Identity facilities selected by generated application assembly. */
interface StatsSources {
  readonly visitors?: boolean
  readonly auth?: boolean
}

/**
 * Declares stats assembly without evaluating configuration or opening resources.
 *
 * @param declaration - Stats settings or environment factory.
 * @param sources - Available identity declarations, selected by generated assembly.
 * @returns Assembly retaining counter types and environment requirements.
 */
export function createStatsAssembly<T extends StatsDeclaration>(
  declaration: T,
  sources?: StatsSources,
): ServiceAssembly<StatsService<InferStatsCounters<T>>> & EnvironmentRequirement<readonly [T]>
export function createStatsAssembly(
  declaration: StatsDeclaration,
  sources: StatsSources = {},
): ServiceAssembly<StatsService> {
  return { expose: true, createRuntime: () => createStatsRuntime(declaration, sources) }
}

function createStatsRuntime(
  declaration: StatsDeclaration,
  sources: StatsSources,
): ServiceRuntime<StatsService> {
  let staticConfig: ResolvedStatsConfig | undefined
  return {
    prepare(env) {
      const config = declaration.isFactory
        ? prepareStatsConfig(declaration, env, sources)
        : (staticConfig ??= prepareStatsConfig(declaration, env, sources))
      return { create: (resources, context) => bindStatsService(config, resources, context) }
    },
  }
}

/** Resolves and checks domain dependencies before any application resource is opened. */
function prepareStatsConfig(
  declaration: StatsDeclaration,
  env: unknown,
  sources: StatsSources,
): ResolvedStatsConfig {
  const config = resolveStatsConfig(declaration, env)
  for (const [name, counter] of Object.entries(config.counters)) {
    let source: keyof StatsSources | undefined
    if (counter.uniqueBy === 'visitor') source = 'visitors'
    else if (counter.uniqueBy === 'user') source = 'auth'
    if (source && !sources[source])
      throw new StatsError(
        'stats_config_error',
        `Counter "${name}" requires the ${source} declaration.`,
      )
  }
  return config
}

/** Creates one store after resources are ready; only owned cleanup transfers to the host. */
async function bindStatsService(
  config: ResolvedStatsConfig,
  resources: Readonly<Record<string, unknown>>,
  context: ServiceCreateContext,
): Promise<ServiceInitResult<StatsService>> {
  const store = await initializeStore(
    config.store,
    {
      env: context.env,
      resources,
      resourceDeclarations: context.resourceDeclarations,
      logger: context.logger,
      target: context.target,
      waitUntil: context.waitUntil,
      signal: context.signal,
      requirements: config.requirements,
    },
    'stats:store',
    context.registerDispose,
  )
  return {
    service: createStatsService(store, config),
    createBinding(binding) {
      const service = createStatsService(store, config, {
        binding,
        resources,
        logger: context.logger,
      })
      binding.ctx.set('stats', service)
      return { state: service }
    },
  }
}
