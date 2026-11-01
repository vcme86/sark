/**
 * MFA configuration resolution and validation.
 *
 * @module
 */

import { validateStoreDeclaration } from '../store'
import type { LoginPolicy, MfaConfig, ResolvedMfaConfig } from './types'

export function resolveMfaConfig(config?: MfaConfig): ResolvedMfaConfig {
  const raw = config ?? {}
  if (raw.state !== undefined) validateStoreDeclaration(raw.state, 'MFA state')

  const login =
    typeof raw.login === 'function' ? raw.login : resolveLoginPolicy(raw.login ?? 'if-enrolled')

  const ttl = raw.challenge?.ttl ?? 300_000
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new Error('MFA challenge.ttl must be a positive finite number in milliseconds.')
  }

  const challengeMaxAttempts = raw.challenge?.maxAttempts ?? 5
  if (!Number.isInteger(challengeMaxAttempts) || challengeMaxAttempts <= 0) {
    throw new Error('MFA challenge.maxAttempts must be a positive integer.')
  }

  const window = raw.accountLimit?.window ?? 600_000
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    throw new Error('MFA accountLimit.window must be a positive finite number in milliseconds.')
  }

  const accountMaxAttempts = raw.accountLimit?.maxAttempts ?? 10
  if (!Number.isInteger(accountMaxAttempts) || accountMaxAttempts <= 0) {
    throw new Error('MFA accountLimit.maxAttempts must be a positive integer.')
  }

  const recentAuthMaxAge = raw.recentAuthMaxAge ?? 300_000
  if (
    typeof recentAuthMaxAge !== 'number' ||
    !Number.isFinite(recentAuthMaxAge) ||
    recentAuthMaxAge <= 0
  ) {
    throw new Error('MFA recentAuthMaxAge must be a positive finite number in milliseconds.')
  }

  let recovery: ResolvedMfaConfig['recovery']
  const recoveryInput = raw.recovery
  if (recoveryInput !== undefined) {
    if (!recoveryInput || typeof recoveryInput !== 'object')
      throw new Error('MFA recovery must be an object.')
    validateStoreDeclaration(recoveryInput.store, 'MFA recovery')
    const count = recoveryInput.count ?? 10
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('MFA recovery count must be a positive integer.')
    }
    recovery = { ...recoveryInput, count }
  }

  return {
    state: raw.state,
    login,
    challenge: {
      ttl,
      maxAttempts: challengeMaxAttempts,
    },
    accountLimit: {
      window,
      maxAttempts: accountMaxAttempts,
    },
    recentAuthMaxAge,
    recovery,
  }
}

/** Validates a dynamic application policy at the callback result boundary. */
export function resolveLoginPolicy(value: unknown): LoginPolicy {
  if (value === 'required' || value === 'if-enrolled' || value === 'skip') return value
  throw new Error('MFA login policy must be "required", "if-enrolled", or "skip".')
}
