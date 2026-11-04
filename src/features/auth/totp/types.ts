/**
 * Types and interfaces for TOTP multi-factor authentication.
 *
 * @module
 */
import type { ResourceAssembly } from '../../../app/resource'
import type { AuthCheckContext } from '../contracts'
import type { StoreDeclaration } from '../store'
import type { TotpAlgorithm } from './config'

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

/** Request-level TOTP handle exposed on `ctx.var.totp`. */
export interface RequestTotp {
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
export interface TotpMaintenance {
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
