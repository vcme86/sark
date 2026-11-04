/**
 * Common MFA policy, configuration, and request service contracts.
 *
 * @module
 */

import type { AuthCheckContext } from '../contracts'
import type { FactorKind, FactorProof } from '../factor'
import type { RecoveryStoreDeclaration } from '../recovery/types'
import type { IssuedSession, SessionOptions, SignInInput } from '../session/types'
import type { AuthStateStoreDeclaration } from '../state/types'

export type SignInPolicy = 'required' | 'if-enrolled' | 'skip'

export type SignInPolicyResolver = (
  identity: SignInInput,
  context: AuthCheckContext,
) => SignInPolicy | Promise<SignInPolicy>

export interface MfaChallengeConfig {
  /** Challenge lifetime in milliseconds; defaults to 300000. */
  readonly ttl?: number
  /** Maximum claims per challenge, including failed proofs; defaults to 5. */
  readonly maxAttempts?: number
}

export interface MfaAccountLimitConfig {
  /** Fixed account/purpose window in milliseconds; defaults to 600000. */
  readonly window?: number
  /** Maximum claims across challenges in one window; defaults to 10. */
  readonly maxAttempts?: number
}

export interface MfaRecoveryConfig {
  readonly store: RecoveryStoreDeclaration
  /** Number of codes in a replacement set; defaults to 10. */
  readonly count?: number
}

export interface MfaConfig {
  /** Defaults to bounded memory on Node; Workers require an explicit shared store. */
  readonly state?: AuthStateStoreDeclaration
  /** Second-step policy after application authentication; defaults to 'if-enrolled'. */
  readonly signIn?: SignInPolicy | SignInPolicyResolver
  readonly challenge?: MfaChallengeConfig
  readonly accountLimit?: MfaAccountLimitConfig
  /**
   * Maximum age of active authentication for factor management, in milliseconds; defaults to 300000.
   */
  readonly recentAuthMaxAge?: number
  /** Recovery codes remain disabled unless this declaration is supplied. */
  readonly recovery?: MfaRecoveryConfig
}

export interface ResolvedMfaConfig {
  readonly state?: AuthStateStoreDeclaration
  readonly signIn: SignInPolicy | SignInPolicyResolver
  readonly challenge: {
    readonly ttl: number
    readonly maxAttempts: number
  }
  readonly accountLimit: {
    readonly window: number
    readonly maxAttempts: number
  }
  readonly recentAuthMaxAge: number
  readonly recovery?: { readonly store: RecoveryStoreDeclaration; readonly count: number }
}

export type SignInResult =
  | { readonly status: 'authenticated'; readonly session: IssuedSession }
  | {
      readonly status: 'challenge'
      readonly challenge: string
      readonly methods: FactorKind[]
    }

export interface RequestMfa<Proof extends FactorProof = FactorProof> {
  /**
   * Continues authentication after the application verifies the first step.
   *
   * @param input - Server-verified identity and authentication facts, never an unvalidated request body.
   * @param options - Session delivery options retained until successful completion.
   * @returns A session, or an opaque challenge and the account's available methods.
   */
  beginSignIn(input: SignInInput, options?: SessionOptions): Promise<SignInResult>
  /** Starts a second-step challenge for the current request's authenticated subject. */
  beginStepUp(options?: SessionOptions): Promise<{ challenge: string; methods: FactorKind[] }>
  /**
   * Verifies a proof, conditionally consumes its state, and then issues a session.
   *
   * @param challenge - Handle returned by beginSignIn, beginStepUp, or WebAuthn beginSignIn.
   * @param proof - Proof for a method selected by this application.
   * @returns The session issued after all required state transitions succeed.
   * @throws AuthError for invalid, limited, expired, or concurrently changed authentication state.
   */
  complete(challenge: string, proof: Proof): Promise<IssuedSession>
  /**
   * Replaces the current subject's recovery set after recent factor authentication or enrollment.
   *
   * @returns New plaintext codes, available only in this response; the previous set is invalidated.
   * @throws AuthError if recovery is disabled, authorization fails, or the stored set changes.
   */
  regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] }>
}
