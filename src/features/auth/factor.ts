import type { StoreContext } from '../../app/store'
/** Shared factor verification and request binding contracts, independent of factor SDKs. */
import type { AuthCheckContext, Identity } from './contracts'
import type { IssuedSession, SessionOptions, SignInInput } from './session/types'
import type { AuthFlow, AuthStateStore } from './state/types'

/** Common management requirements consumed by factor implementations. */
export interface FactorPolicy {
  readonly challenge: { readonly ttl: number; readonly maxAttempts: number }
  readonly recentAuthMaxAge: number
}

export interface SessionService {
  signIn: (input: SignInInput, options?: SessionOptions) => Promise<IssuedSession>
}

export type FactorProof =
  | { readonly kind: 'totp'; readonly code: string }
  | { readonly kind: 'recovery'; readonly code: string }
  | { readonly kind: 'webauthn'; readonly response: unknown }

export type FactorKind = FactorProof['kind']

export interface FactorVerifier {
  readonly kind: Exclude<FactorKind, 'recovery'>
  readonly isEnabled: (sub: string, context: AuthCheckContext) => Promise<boolean>
  readonly binding?: (sub: string, context: AuthCheckContext) => Promise<string | null>
  readonly findSubject?: (proof: FactorProof, context: AuthCheckContext) => Promise<string | null>
  readonly identity?: (sub: string, context: AuthCheckContext) => SignInInput | Promise<SignInInput>
  readonly verifyProof: (
    flow: AuthFlow,
    proof: FactorProof,
    context: AuthCheckContext,
  ) => Promise<{ verified: boolean; sub?: string; userVerified?: boolean }>
}

export interface FactorRequestContext {
  readonly context: AuthCheckContext
  readonly getIdentity: () => Identity | undefined
  readonly hasOtherFactor: (sub: string) => Promise<boolean>
  readonly onEnroll: (sub: string) => void
}

export interface FactorInstance {
  readonly verifier: FactorVerifier
  readonly bind: (context: FactorRequestContext) => unknown
}

/** Selected at build time; unselected factors never enter the module graph. */
export interface FactorAssembly {
  readonly kind: Exclude<FactorKind, 'recovery'>
  readonly prepare: (env: unknown) => {
    readonly create: (
      context: StoreContext,
      state: AuthStateStore,
      policy: FactorPolicy,
      registerDispose: (name: string, dispose: () => Promise<void> | void) => void,
    ) => Promise<FactorInstance>
  }
}
