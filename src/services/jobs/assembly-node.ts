/**
 * Node.js background jobs runtime assembly and lifecycle coordination.
 *
 * @module
 */

import type { ServiceAssembly, ServiceInitResult, ServiceRuntime } from '../../core/service'
import { resolveJobsDeclaration } from './declaration'
import { createNodeJobsManager } from './node'
import type { JobsDeclaration, JobsManager } from './types'

/**
 * Creates a domain service assembly providing the Node.js background jobs manager.
 *
 * @param declaration - Declared jobs configuration or environment factory.
 * @returns Service assembly that initializes NodeJobsManager on host startup.
 */
export function createNodeJobsAssembly(declaration: JobsDeclaration): ServiceAssembly<JobsManager> {
  return {
    expose: true,
    createRuntime(): ServiceRuntime<JobsManager> {
      return {
        prepare(env) {
          const evaluatedJobs = resolveJobsDeclaration(declaration, env, 'node')
          return {
            create(resources, context): ServiceInitResult<JobsManager> {
              const manager = createNodeJobsManager(evaluatedJobs, {
                signal: context.signal,
                drainingSignal: context.drainingSignal,
                env: context.env,
                resources,
                waitUntil: context.waitUntil,
                shutdown: context.shutdown!,
              })

              context.onReady!((readyContext) => manager.start(readyContext))

              context.registerDispose('jobs', (disposalContext) =>
                manager.close(disposalContext.deadline),
              )

              return {
                service: manager,
              }
            },
          }
        },
      }
    },
  }
}
