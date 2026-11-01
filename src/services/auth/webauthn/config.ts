/**
 * WebAuthn configuration resolution and validation.
 *
 * @module
 */

import { validateStoreDeclaration } from '../store'
import type { ResolvedWebAuthnConfig, WebAuthnConfig } from './types'

export function resolveWebAuthnConfig(config: WebAuthnConfig): ResolvedWebAuthnConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('WebAuthn configuration must be an object.')
  }

  const rpId = config.rpId
  if (!rpId || typeof rpId !== 'string') {
    throw new Error('WebAuthn configuration requires a non-empty rpId string.')
  }

  const rpName = config.rpName
  if (!rpName || typeof rpName !== 'string') {
    throw new Error('WebAuthn configuration requires a non-empty rpName string.')
  }

  if (!Array.isArray(config.origins) || config.origins.length === 0) {
    throw new Error('WebAuthn configuration requires a non-empty origins array.')
  }
  for (const origin of config.origins) {
    if (!origin || typeof origin !== 'string') {
      throw new Error('WebAuthn origins must contain only non-empty strings.')
    }
  }

  validateStoreDeclaration(config.store, 'WebAuthn')

  if (typeof config.user !== 'function') {
    throw new Error('WebAuthn configuration requires a user resolver function.')
  }

  if (config.identity !== undefined && typeof config.identity !== 'function') {
    throw new Error('WebAuthn identity resolver must be a function if provided.')
  }

  const userVerification = config.userVerification ?? 'required'
  if (!['required', 'preferred', 'discouraged'].includes(userVerification)) {
    throw new Error(`Invalid userVerification mode "${userVerification}".`)
  }

  const timeout = config.timeout ?? 60_000
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('WebAuthn timeout must be a positive integer in milliseconds.')
  }

  return {
    rpId,
    rpName,
    origins: [...config.origins],
    store: config.store,
    user: config.user,
    identity: config.identity,
    userVerification,
    timeout,
  }
}
