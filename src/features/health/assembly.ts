/** Prepares Node probe checks before application resources are created. */
import type { HealthPreparation } from '../../adapter/node/probes'
import { resolveHealthConfig } from './declaration'
import { createHealthCheckRunner } from './runner'
import type { HealthDeclaration } from './types'

/**
 * Selects probe preparation without evaluating factories or running checks.
 *
 * @param declaration - Health options or host environment factory.
 * @returns A host preparation function; its runner is bound after application resources are ready.
 */
export function createHealthAssembly(declaration: HealthDeclaration): HealthPreparation {
  return (env, enabled) => {
    if (!enabled)
      throw new Error(
        'Configuration conflict: health checks declared while runtime.probes is disabled.',
      )
    const config = resolveHealthConfig(declaration, env)
    return {
      auth: config.auth,
      createRunner: (resources, lifecycle) => createHealthCheckRunner(config, resources, lifecycle),
    }
  }
}
