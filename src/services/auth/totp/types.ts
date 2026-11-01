/**
 * Types and interfaces for TOTP multi-factor authentication.
 *
 * @module
 */
import type { ResourceAssembly } from '../../../core/resource'
import type { AuthCheckContext } from '../contracts'
import type { StoreDeclaration } from '../store'

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

/** Stored TOTP enrollment record for one user. */
export interface TotpRecord {
  /** Changes on every successful conditional write. */
  readonly revision: string
  /** Changes only when the factor is replaced. */
  readonly factorId: string
  readonly algorithm: TotpAlgorithm
  readonly digits: number
  readonly period: number
  /** Opaque AES-GCM envelope, bound to the subject and factor identifier. */
  readonly secret: Uint8Array
  /** Last accepted time-step index, rather than a timestamp. */
  readonly lastStep: number
  /** Enrollment time as Unix milliseconds. */
  readonly enabledAt: number
}

/** Dedicated store managing encrypted TOTP factor records with optimistic concurrency. */
export interface TotpStore {
  /** Reads current TOTP record. Returns null if none enrolled. */
  read: (sub: string, context: AuthCheckContext) => Promise<TotpRecord | null>
  /**
   * Inserts only when expectedRevision is null, otherwise replaces or deletes that version.
   * @returns False for a version/uniqueness conflict; storage failures must throw.
   */
  commit: (
    sub: string,
    expectedRevision: string | null,
    next: TotpRecord | null,
    context: AuthCheckContext,
  ) => Promise<boolean>
}

export type TotpStoreDeclaration<Env = unknown> = StoreDeclaration<TotpStore, Env>

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

/** Request-level TOTP handle exposed on `ctx.var.totp`. */
export interface TotpService {
  /** Creates a pending encrypted factor for the current subject after the management checks. */
  beginEnrollment(): Promise<{ challenge: string; uri: string }>
  /**
   * Confirms the pending factor with an OTP and conditionally consumes its enrollment flow.
   * @param challenge - Opaque handle from beginEnrollment.
   * @param code - Authenticator code generated from the displayed URI.
   * @returns Success only after both the factor and flow transitions succeed.
   */
  confirmEnrollment(challenge: string, code: string): Promise<{ enabled: true }>
  /** Removes the current factor after recent factor authentication. */
  disable(): Promise<void>
  /** Checks enrollment for an application-authorized subject, without authenticating it. */
  isEnabled(sub: string): Promise<boolean>
}

/** Application-level instance maintenance methods exposed on `instance.totp`. */
export interface TotpPublicInstance {
  /**
   * Re-encrypts one subject's factor using the current key, preserving replay state.
   * @param sub - Subject selected by application maintenance code.
   * @returns True if already current or updated; false if absent or changed concurrently.
   */
  reencrypt: (sub: string) => Promise<boolean>
}

export interface SqlTotpOptions<Factors = unknown> {
  readonly database: ResourceAssembly
  readonly tables?: {
    readonly factors?: Factors
  }
}
