/** Common MFA policy, one-time proof completion, and request-bound session issuance. */
import type { AuthCheckContext, Identity } from '../contracts'
import { MfaError } from '../error'
import type { FactorVerifier, SessionService } from '../factor'
import { generateRecoveryCodes, hashRecoveryCode } from '../recovery/service'
import type { RecoveryStore } from '../recovery/types'
import { validateSignInInput } from '../session/token'
import type { IssuedSession, SessionOptions, SignInInput } from '../session/types'
import {
  assertActive,
  createChallenge,
  requireIdentity,
  requireRecentAuthentication,
} from '../state/flow'
import type { AuthStateStore } from '../state/types'
import { completeAuthentication } from '../verification'
import { resolveLoginPolicy } from './config'
import type {
  LoginResult,
  LoginResultMethods,
  MfaProof,
  MfaService,
  ResolvedMfaConfig,
} from './types'

interface MfaServiceDependencies {
  readonly config: ResolvedMfaConfig
  readonly stateStore: AuthStateStore
  readonly recoveryStore?: RecoveryStore
  readonly sessionService: SessionService
  readonly factors: readonly FactorVerifier[]
  readonly getCurrentIdentity?: () => Identity | undefined
  readonly context: AuthCheckContext
  readonly wasFactorEnrolledInRequest?: (sub: string) => boolean
}

export class MfaServiceImpl implements MfaService {
  constructor(private readonly deps: MfaServiceDependencies) {}

  private async methods(
    sub: string,
  ): Promise<{ methods: LoginResultMethods; bindings: Record<string, string> }> {
    const methods: LoginResultMethods = []
    const bindings: Record<string, string> = {}
    for (const factor of this.deps.factors) {
      if (factor.binding) {
        const binding = await factor.binding(sub, this.deps.context)
        if (binding !== null) {
          bindings[factor.kind] = binding
          methods.push(factor.kind)
        }
      } else if (await factor.isEnabled(sub, this.deps.context)) methods.push(factor.kind)
    }
    if (this.deps.recoveryStore && (await this.deps.recoveryStore.read(sub))?.hashes.length)
      methods.push('recovery')
    return { methods, bindings }
  }

  async beginLogin(input: SignInInput, options?: SessionOptions): Promise<LoginResult> {
    assertActive(this.deps.context)
    validateSignInInput(input)
    const policy =
      typeof this.deps.config.login === 'function'
        ? resolveLoginPolicy(await this.deps.config.login(input, this.deps.context))
        : this.deps.config.login
    const firstStep = { ...input, authTime: input.authTime ?? Math.floor(Date.now() / 1000) }
    if (policy === 'skip') {
      assertActive(this.deps.context)
      return {
        status: 'authenticated',
        session: await this.deps.sessionService.signIn(firstStep, options),
      }
    }
    const available = await this.methods(input.sub)
    if (!available.methods.length) {
      if (policy === 'required')
        throw new MfaError('factor_missing', 'No enrolled authentication factor is available.')
      assertActive(this.deps.context)
      return {
        status: 'authenticated',
        session: await this.deps.sessionService.signIn(firstStep, options),
      }
    }
    const challenge = await createChallenge(
      this.deps.stateStore,
      this.deps.config.challenge,
      'login',
      {
        signInInput: firstStep,
        sessionOptions: options,
        methods: available.methods,
        factorBindings: available.bindings,
      },
      input.sub,
    )
    return { status: 'challenge', challenge, methods: available.methods }
  }

  async beginStepUp(
    options?: SessionOptions,
  ): Promise<{ challenge: string; methods: LoginResultMethods }> {
    assertActive(this.deps.context)
    const identity = requireIdentity(this.deps.getCurrentIdentity)
    const available = await this.methods(identity.sub)
    if (!available.methods.length)
      throw new MfaError('factor_missing', 'No enrolled authentication factor is available.')
    const challenge = await createChallenge(
      this.deps.stateStore,
      this.deps.config.challenge,
      'step-up',
      { sessionOptions: options, methods: available.methods, factorBindings: available.bindings },
      identity.sub,
    )
    return { challenge, methods: available.methods }
  }

  complete(challenge: string, proof: MfaProof): Promise<IssuedSession> {
    return completeAuthentication(
      { ...this.deps, accountLimit: this.deps.config.accountLimit },
      challenge,
      proof,
    )
  }

  async regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] }> {
    assertActive(this.deps.context)
    const identity = requireIdentity(this.deps.getCurrentIdentity)
    const config = this.deps.config.recovery
    if (!config || !this.deps.recoveryStore)
      throw new MfaError('factor_missing', 'Recovery codes are not configured.')
    if (!this.deps.wasFactorEnrolledInRequest?.(identity.sub))
      requireRecentAuthentication(identity, this.deps.config.recentAuthMaxAge, true)
    const codes = generateRecoveryCodes(config.count)
    const hashes = await Promise.all(codes.map(hashRecoveryCode))
    const previous = await this.deps.recoveryStore.read(identity.sub)
    assertActive(this.deps.context)
    if (
      !(await this.deps.recoveryStore.commit(identity.sub, previous?.revision ?? null, {
        revision: crypto.randomUUID(),
        hashes,
      }))
    )
      throw new MfaError('conflict', 'Recovery codes changed concurrently.')
    return { recoveryCodes: codes }
  }
}
