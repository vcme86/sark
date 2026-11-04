/**
 * TOTP configuration resolution and validation.
 *
 * @module
 */

import type { BaseDeclaration, RequiresEnv } from '../../../app/declaration'
import { validateStoreDeclaration } from '../store'
import type { TotpStoreDeclaration } from './types'

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

/** Cryptographic key definition for AES-256-GCM TOTP secret encryption. */
export interface TotpKey {
  readonly id: string
  readonly key: Uint8Array
}

/** Encryption key ring for TOTP secrets at rest. */
export interface TotpKeyConfig {
  /** Current active encryption key (must be exactly 32 bytes for AES-256-GCM). */
  readonly current: { readonly id: string | undefined; readonly key: Uint8Array | undefined }
  /** Retired encryption keys accepted for decryption only. */
  readonly retired?: readonly TotpKey[]
}

export interface TotpConfig {
  readonly issuer: string | undefined
  readonly keys: TotpKeyConfig
  readonly store: TotpStoreDeclaration
  /** Defaults to SHA1. */
  readonly algorithm?: TotpAlgorithm
  /** Token length, from 6 to 8 digits; defaults to 6. */
  readonly digits?: number
  /** Time-step duration in seconds; defaults to 30. */
  readonly period?: number
  /** Accepted time deviation in seconds, following otplib; defaults to 30. */
  readonly epochTolerance?: number
}

export interface ResolvedTotpConfig {
  readonly issuer: string
  readonly keys: {
    readonly current: TotpKey
    readonly retired: readonly TotpKey[]
    readonly byId: ReadonlyMap<string, TotpKey>
  }
  readonly store: TotpStoreDeclaration
  readonly algorithm: TotpAlgorithm
  readonly digits: number
  readonly period: number
  readonly epochTolerance: number
}

const DEFAULT_TOTP_CONFIG = {
  algorithm: 'SHA1' as TotpAlgorithm,
  digits: 6,
  period: 30,
  epochTolerance: 30,
} as const

function validateKey(keyConfig: { id: string | undefined; key: unknown }, desc: string): TotpKey {
  if (!keyConfig.id || typeof keyConfig.id !== 'string') {
    throw new Error(`TOTP ${desc} must have a non-empty string id.`)
  }
  if (!(keyConfig.key instanceof Uint8Array)) {
    throw new Error(`TOTP ${desc} key must be a Uint8Array.`)
  }
  if (keyConfig.key.length !== 32) {
    throw new Error(
      `TOTP ${desc} key must be exactly 32 bytes for AES-256-GCM, got ${keyConfig.key.length}.`,
    )
  }
  if (new TextEncoder().encode(keyConfig.id).length > 255)
    throw new Error('TOTP key id must not exceed 255 UTF-8 bytes.')
  return { id: keyConfig.id, key: new Uint8Array(keyConfig.key) }
}

export function resolveTotpConfig(config: TotpConfig): ResolvedTotpConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('TOTP configuration must be an object.')
  }
  if (!config.issuer || typeof config.issuer !== 'string') {
    throw new Error('TOTP configuration requires a non-empty issuer string.')
  }
  if (!config.keys || !config.keys.current) {
    throw new Error('TOTP configuration requires keys.current key.')
  }
  validateStoreDeclaration(config.store, 'TOTP')

  const current = validateKey(config.keys.current, 'current key')
  const keyIds = new Set<string>([current.id])

  const retired: TotpKey[] = []
  if (config.keys.retired) {
    if (!Array.isArray(config.keys.retired)) {
      throw new Error('TOTP keys.retired must be an array.')
    }
    for (const k of config.keys.retired) {
      const valid = validateKey(k, `retired key "${k.id}"`)
      if (keyIds.has(valid.id)) {
        throw new Error(`Duplicate TOTP key id "${valid.id}".`)
      }
      keyIds.add(valid.id)
      retired.push(valid)
    }
  }

  const algorithm = config.algorithm ?? DEFAULT_TOTP_CONFIG.algorithm
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) {
    throw new Error(`Invalid TOTP algorithm "${algorithm}". Expected SHA1, SHA256, or SHA512.`)
  }

  const digits = config.digits ?? DEFAULT_TOTP_CONFIG.digits
  if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error(`TOTP digits must be an integer between 6 and 8, got ${digits}.`)
  }

  const period = config.period ?? DEFAULT_TOTP_CONFIG.period
  if (typeof period !== 'number' || !Number.isInteger(period) || period <= 0) {
    throw new Error(`TOTP period must be a positive integer of seconds, got ${period}.`)
  }

  const epochTolerance = config.epochTolerance ?? DEFAULT_TOTP_CONFIG.epochTolerance
  if (
    typeof epochTolerance !== 'number' ||
    !Number.isFinite(epochTolerance) ||
    epochTolerance < 0
  ) {
    throw new Error(
      `TOTP epochTolerance must be a non-negative number of seconds, got ${epochTolerance}.`,
    )
  }

  return {
    issuer: config.issuer,
    keys: {
      current,
      retired,
      byId: new Map([current, ...retired].map((key) => [key.id, key])),
    },
    store: config.store,
    algorithm,
    digits,
    period,
    epochTolerance,
  }
}

type TotpInput = TotpConfig | ((env: any) => TotpConfig)

/** TOTP declaration holding input settings. */
export interface TotpDeclaration extends BaseDeclaration<'totp', TotpConfig> {}

/**
 * Declares the TOTP authentication factor for the application.
 *
 * @param config - Static TOTP options.
 * @returns A TOTP declaration.
 */
export function defineTotp(config: TotpConfig): TotpDeclaration

/**
 * Declares the TOTP authentication factor resolved once per application or event.
 *
 * @param factory - Receives environment and returns TOTP options.
 * @returns A TOTP declaration requiring typed environment.
 */
export function defineTotp<E>(factory: (env: E) => TotpConfig): TotpDeclaration & RequiresEnv<E>

export function defineTotp(input: TotpInput): TotpDeclaration {
  return {
    kind: 'totp',
    value: input,
    isFactory: typeof input === 'function',
  }
}
