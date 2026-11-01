/** Common challenge creation, expiry, cancellation, and factor-management authorization. */
import type { AuthCheckContext, Identity } from '../contracts'
import { MfaError } from '../error'
import type { FactorPolicy } from '../factor'
import type { AuthFlow, AuthFlowPurpose, AuthStateStore } from './types'

export function assertActive(context: AuthCheckContext, flow?: AuthFlow): void {
  context.signal?.throwIfAborted()
  if (flow && Date.now() >= flow.expiresAt)
    throw new MfaError('challenge_invalid', 'Authentication challenge expired.')
}

export function requireRecentAuthentication(
  identity: Identity,
  maxAge: number,
  requireFactor: boolean,
): void {
  if (
    identity.authTime === undefined ||
    Date.now() - identity.authTime * 1000 > maxAge ||
    (requireFactor && !identity.authentication)
  ) {
    throw new MfaError('step_up_required', 'Recent authentication is required for this operation.')
  }
}

/** Creates an opaque flow using the already resolved common challenge policy. */
export async function createChallenge(
  store: AuthStateStore,
  policy: FactorPolicy['challenge'],
  purpose: AuthFlowPurpose,
  data: Record<string, unknown>,
  sub?: string,
  protocol?: Readonly<Record<string, unknown>>,
): Promise<string> {
  const now = Date.now()
  const id = crypto.randomUUID()
  const created = await store.create({
    id,
    revision: crypto.randomUUID(),
    purpose,
    sub,
    createdAt: now,
    expiresAt: now + policy.ttl,
    attempts: 0,
    maxAttempts: policy.maxAttempts,
    status: 'pending',
    data,
    protocol,
  })
  if (!created) throw new MfaError('storage_error', 'Could not create authentication challenge.')
  return id
}

/** Completes a claimed flow without granting success to cancelled or late operations. */
export async function consumeChallenge(
  store: AuthStateStore,
  flow: AuthFlow,
  claimId: string,
  context: AuthCheckContext,
): Promise<void> {
  assertActive(context, flow)
  if (!(await store.consume(flow.id, claimId, Date.now())))
    throw new MfaError('challenge_invalid', 'Authentication challenge could not be consumed.')
  assertActive(context, flow)
}

/** Resolves the current subject, optionally requiring the account selected by an earlier step. */
export function requireIdentity(
  getIdentity: (() => Identity | undefined) | undefined,
  sub?: string,
): Identity {
  const identity = getIdentity?.()
  if (!identity || (sub !== undefined && identity.sub !== sub))
    throw new MfaError('step_up_required', 'An unchanged authenticated session is required.')
  return identity
}
