/** TOTP-only runtime selection; importing it never loads another factor's SDK. */
import { evaluateDeclaration } from '../../../core/declaration'
import type { ServiceAssembly } from '../../../core/service'
import type { FactorAssembly } from '../factor'
import { initializeStore } from '../store'
import { resolveTotpConfig } from './config'
import type { TotpDeclaration } from './declaration'
import { TotpServiceImpl } from './service'
import type { TotpPublicInstance } from './types'

export function createTotpFactor(declaration: TotpDeclaration): FactorAssembly & {
  readonly kind: 'totp'
  readonly maintenance: ServiceAssembly<TotpPublicInstance>
} {
  const initialized = new WeakMap<Readonly<Record<string, unknown>>, TotpPublicInstance>()
  return {
    kind: 'totp',
    maintenance: {
      expose: true,
      requires: ['mfa'],
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
      const config = resolveTotpConfig(evaluateDeclaration(declaration.value, env, 'totp'))
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
          const service = new TotpServiceImpl(base)
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
              new TotpServiceImpl({
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
