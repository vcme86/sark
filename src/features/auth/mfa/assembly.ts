/** MFA policy composition using explicitly selected factor implementations. */
import { evaluateDeclaration } from '../../../app/declaration'
import type { ServiceAssembly } from '../../../app/service'
import { initializeStore, type StoreContext } from '../../../app/store'
import type { AuthCheckContext } from '../contracts'
import type { FactorAssembly, FactorInstance } from '../factor'
import type { RequestAuth } from '../session/types'
import { memoryState } from '../state/memory'
import { resolveMfaConfig } from './config'
import type { MfaDeclaration } from './declaration'
import { MfaService } from './service'

interface MfaAssemblyOptions {
  readonly mfa?: MfaDeclaration
  readonly factors: readonly FactorAssembly[]
}

/** Creates common authentication coordination without owning a factor-specific instance API. */
export function createMfaAssembly(options: MfaAssemblyOptions): ServiceAssembly<never> {
  const resolvePolicy = (env: unknown) =>
    resolveMfaConfig(options.mfa ? evaluateDeclaration(options.mfa.value, env, 'mfa') : {})
  return {
    createRuntime: () => {
      let staticPolicy: ReturnType<typeof resolveMfaConfig> | undefined
      return {
        prepare(env) {
          const policy = options.mfa?.isFactory
            ? resolvePolicy(env)
            : (staticPolicy ??= resolvePolicy(env))
          const factors = options.factors.map((factor) => factor.prepare(env))
          return {
            async create(resources, context) {
              const storeContext: StoreContext = {
                env,
                resources,
                resourceDeclarations: context.resourceDeclarations,
                signal: context.signal,
                logger: context.logger,
                target: context.target,
                waitUntil: context.waitUntil,
              }
              const stateDeclaration =
                policy.state ?? (context.target === 'node' ? memoryState() : undefined)
              if (!stateDeclaration)
                throw new Error('Workers MFA requires an explicit shared state store.')
              const state = await initializeStore(
                stateDeclaration,
                storeContext,
                'authentication state',
                context.registerDispose,
              )
              const recovery = policy.recovery
                ? await initializeStore(
                    policy.recovery.store,
                    storeContext,
                    'recovery',
                    context.registerDispose,
                  )
                : undefined
              const instances: FactorInstance[] = []
              for (const factor of factors)
                instances.push(
                  await factor.create(storeContext, state, policy, context.registerDispose),
                )
              const verifiers = instances.map((instance) => instance.verifier)
              return {
                createBinding(binding) {
                  const auth = binding.ctx.get('auth') as RequestAuth
                  const enrolled =
                    (binding.parentBinding?.state as Set<string> | undefined) ?? new Set<string>()
                  const checkContext: AuthCheckContext = {
                    ...resources,
                    logger: context.logger,
                    signal: binding.signal,
                    request: binding.request,
                  }
                  const getIdentity = () => auth.identity ?? undefined
                  for (const instance of instances) {
                    binding.ctx.set(
                      instance.verifier.kind,
                      instance.bind({
                        context: checkContext,
                        getIdentity,
                        hasOtherFactor: async (sub) => {
                          for (const other of instances)
                            if (
                              other !== instance &&
                              (await other.verifier.isEnabled(sub, checkContext))
                            )
                              return true
                          return !!(recovery && (await recovery.read(sub))?.hashes.length)
                        },
                        onEnroll: (sub) => enrolled.add(sub),
                      }),
                    )
                  }
                  binding.ctx.set(
                    'mfa',
                    new MfaService({
                      config: policy,
                      stateStore: state,
                      recoveryStore: recovery,
                      sessionService: auth,
                      factors: verifiers,
                      getCurrentIdentity: getIdentity,
                      context: checkContext,
                      wasFactorEnrolledInRequest: (sub) => enrolled.has(sub),
                    }),
                  )
                  return { state: enrolled }
                },
              }
            },
          }
        },
      }
    },
  }
}
