/** WebAuthn-only runtime selection and resource binding. */
import type { AuthenticationResponseJSON } from '@simplewebauthn/server'

import { evaluateDeclaration } from '../../../core/declaration'
import type { FactorAssembly } from '../factor'
import { initializeStore } from '../store'
import { resolveWebAuthnConfig } from './config'
import type { WebAuthnDeclaration } from './declaration'
import { authenticationCredentialId, WebAuthnServiceImpl } from './service'

export function createWebAuthnFactor(
  declaration: WebAuthnDeclaration,
): FactorAssembly & { readonly kind: 'webauthn' } {
  return {
    kind: 'webauthn',
    prepare(env) {
      const config = resolveWebAuthnConfig(evaluateDeclaration(declaration.value, env, 'webauthn'))
      return {
        async create(context, stateStore, policy, registerDispose) {
          const store = await initializeStore(config.store, context, 'webauthn', registerDispose)
          const base = {
            context: { ...context.resources, logger: context.logger, signal: context.signal },
            config,
            webauthnStore: store,
            stateStore,
            policy,
          }
          const service = new WebAuthnServiceImpl(base)
          return {
            verifier: {
              kind: 'webauthn',
              isEnabled: (sub) => service.isEnabled(sub),
              findSubject: async (proof) =>
                proof.kind === 'webauthn'
                  ? ((await store.findCredential(authenticationCredentialId(proof.response)))
                      ?.sub ?? null)
                  : null,
              identity: config.identity,
              verifyProof: (flow, proof, request) => {
                if (proof.kind !== 'webauthn')
                  throw new Error('Invalid WebAuthn verifier dispatch.')
                return service.verifyProof(
                  flow,
                  proof.response as AuthenticationResponseJSON,
                  request,
                )
              },
            },
            bind: (request) =>
              new WebAuthnServiceImpl({
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
