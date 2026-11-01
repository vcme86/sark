/** Proof consumption and session issuance shared by second-step and passwordless authentication. */
import type { AuthCheckContext, AuthFacts, Identity } from './contracts'
import { AuthError } from './error'
import type { FactorProof, FactorVerifier, SessionService } from './factor'
import { verifyRecoveryCode } from './recovery/service'
import type { RecoveryStore } from './recovery/types'
import type { IssuedSession, SessionOptions, SignInInput } from './session/types'
import { assertActive, consumeChallenge, requireIdentity } from './state/flow'
import type { AuthStateStore } from './state/types'

interface CompletionOptions {
  readonly stateStore: AuthStateStore
  readonly recoveryStore?: RecoveryStore
  readonly sessionService: SessionService
  readonly factors: readonly FactorVerifier[]
  readonly accountLimit: { readonly window: number; readonly maxAttempts: number }
  readonly getCurrentIdentity?: () => Identity | undefined
  readonly context: AuthCheckContext
}

/** Verifies one proof and closes its challenge before issuing the resulting session. */
export async function completeAuthentication(
  options: CompletionOptions,
  challenge: string,
  proof: FactorProof,
): Promise<IssuedSession> {
  assertActive(options.context)
  if (!proof || typeof proof !== 'object' || !['totp', 'webauthn', 'recovery'].includes(proof.kind))
    throw new AuthError('invalid_code', 'Invalid authentication proof.')
  const flow = await options.stateStore.read(challenge)
  if (!flow || !['sign-in', 'step-up', 'webauthn-sign-in'].includes(flow.purpose))
    throw new AuthError('challenge_invalid', 'Invalid authentication challenge.')
  assertActive(options.context, flow)
  if (flow.purpose === 'step-up') requireIdentity(options.getCurrentIdentity, flow.sub)
  if (flow.purpose !== 'webauthn-sign-in' && !(flow.data.methods as string[]).includes(proof.kind))
    throw new AuthError(
      'factor_missing',
      'This factor was not available when authentication began.',
    )
  let sub = flow.sub
  const factor = options.factors.find((candidate) => candidate.kind === proof.kind)
  if (flow.purpose === 'webauthn-sign-in') {
    if (proof.kind !== 'webauthn' || !factor?.findSubject)
      throw new AuthError('challenge_invalid', 'Passwordless login requires a WebAuthn proof.')
    sub = (await factor.findSubject(proof, options.context)) ?? undefined
  }
  if (!sub)
    throw new AuthError('challenge_invalid', 'Authentication subject could not be resolved.')
  const claimId = crypto.randomUUID()
  const claim = await options.stateStore.claim(challenge, claimId, Date.now(), {
    sub,
    purpose: flow.purpose,
    ...options.accountLimit,
  })
  if (claim.status === 'limited')
    throw new AuthError('too_many_attempts', 'Account authentication attempt limit exceeded.')
  if (claim.status !== 'claimed')
    throw new AuthError('challenge_invalid', 'Authentication challenge is unavailable.')
  let auth: AuthFacts
  try {
    if (proof.kind === 'recovery') {
      if (!options.recoveryStore)
        throw new AuthError('factor_missing', 'Recovery codes are not configured.')
      const record = await options.recoveryStore.read(sub)
      if (!record) throw new AuthError('invalid_code', 'Invalid recovery code.')
      const checked = await verifyRecoveryCode(proof.code, record.hashes)
      if (!checked.valid) throw new AuthError('invalid_code', 'Invalid recovery code.')
      assertActive(options.context, claim.flow)
      if (
        !(await options.recoveryStore.commit(sub, record.revision, {
          revision: crypto.randomUUID(),
          hashes: record.hashes.filter((_, index) => index !== checked.matchedIndex),
        }))
      )
        throw new AuthError('conflict', 'Recovery code was consumed concurrently.')
      auth = { method: 'recovery' }
    } else {
      if (!factor) throw new AuthError('factor_missing', 'Authentication factor is not configured.')
      const verified = await factor.verifyProof(claim.flow, proof, options.context)
      if (!verified.verified) throw new AuthError('invalid_code', 'Invalid factor proof.')
      if (verified.sub !== undefined && verified.sub !== sub)
        throw new AuthError('conflict', 'Authentication factor owner changed.')
      auth =
        proof.kind === 'webauthn'
          ? { method: 'webauthn', userVerified: verified.userVerified === true }
          : { method: 'totp' }
    }
  } catch (error) {
    if (error instanceof AuthError && error.code === 'invalid_code')
      await options.stateStore.release(challenge, claimId, Date.now())
    throw error
  }
  await consumeChallenge(options.stateStore, claim.flow, claimId, options.context)
  let input: SignInInput
  if (flow.purpose === 'step-up') {
    const identity = requireIdentity(options.getCurrentIdentity, sub)
    input = {
      sub,
      ver: identity.ver,
      roles: identity.roles,
      claims: identity.claims,
      amr: identity.amr,
    }
  } else if (flow.purpose === 'webauthn-sign-in') {
    const resolved = factor?.identity ? await factor.identity(sub, options.context) : { sub }
    if (resolved.sub !== sub)
      throw new Error('WebAuthn identity resolver returned a different subject.')
    input = { sub, ver: resolved.ver, roles: resolved.roles, claims: resolved.claims }
  } else input = flow.data.signInInput as SignInInput
  assertActive(options.context, claim.flow)
  const amr = proof.kind === 'webauthn' ? 'pop' : 'otp'
  return options.sessionService.signIn(
    {
      ...input,
      amr: [...new Set([...(input.amr ?? []), amr])],
      authTime: Math.floor(Date.now() / 1000),
      auth,
    },
    flow.data.sessionOptions as SessionOptions | undefined,
  )
}
