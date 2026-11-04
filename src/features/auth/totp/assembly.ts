/** TOTP-only runtime selection; importing it never loads another factor's SDK. */
import { evaluateDeclaration } from '../../../app/declaration'
import type { ServiceAssembly } from '../../../app/service'
import { initializeStore } from '../../../app/store'
import type { FactorAssembly } from '../factor'
import { resolveTotpConfig, type TotpDeclaration } from './config'
import { TotpService } from './service'
import type { TotpMaintenance } from './types'

export function createTotpFactor(declaration: TotpDeclaration): FactorAssembly & {
  readonly kind: 'totp'
  readonly maintenance: ServiceAssembly<TotpMaintenance>
} {
  const initialized = new WeakMap<Readonly<Record<string, unknown>>, TotpMaintenance>()
  let staticConfig: ReturnType<typeof resolveTotpConfig> | undefined
  return {
    kind: 'totp',
    maintenance: {
      expose: true,
      createRuntime: () => ({
        prepare: () => ({
          create(resources) {
            const service = initialized.get(resources)
            if (!service)
              throw new Error('TOTP maintenance requires its factor in the selected MFA assembly.')
            return { service }
          },
        }),
      }),
    },
    prepare(env) {
      const config = declaration.isFactory
        ? resolveTotpConfig(evaluateDeclaration(declaration.value, env, 'totp'))
        : (staticConfig ??= resolveTotpConfig(evaluateDeclaration(declaration.value, env, 'totp')))
      return {
        async create(context, stateStore, policy, registerDispose) {
          const store = await initializeStore(config.store, context, 'totp', registerDispose)
          const base = {
            context: { ...context.resources, logger: context.logger, signal: context.signal },
            config,
            totpStore: store,
            stateStore,
            policy,
          }
          const service = new TotpService(base)
          initialized.set(context.resources, { reencrypt: (sub) => service.reencrypt(sub) })
          return {
            verifier: {
              kind: 'totp',
              isEnabled: (sub, request) => service.isEnabled(sub, request),
              binding: async (sub, request) => (await store.read(sub, request))?.factorId ?? null,
              verifyProof: (flow, proof, request) => {
                if (proof.kind !== 'totp') throw new Error('Invalid TOTP verifier dispatch.')
                return service.verifyProof(flow, proof.code, request)
              },
            },
            bind: (request) =>
              new TotpService({
                ...base,
                context: request.context,
                getCurrentIdentity: request.getIdentity,
                hasOtherFactor: request.hasOtherFactor,
                markFactorEnrolledInRequest: request.onEnroll,
              }),
          }
        },
      }
    },
  }
}
