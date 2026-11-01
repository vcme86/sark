/**
 * Types and contracts for recovery code generation, verification, and persistence.
 *
 * @module
 */
import type { ResourceAssembly } from '../../../core/resource'
import type { StoreDeclaration } from '../store'

/** Stored recovery codes record for one user. */
export interface RecoveryRecord {
  readonly revision: string
  readonly hashes: readonly string[]
}

/** Dedicated store managing hashed recovery codes with optimistic concurrency. */
export interface RecoveryStore {
  /** Reads current recovery codes record. Returns null if none enrolled. */
  read: (sub: string) => Promise<RecoveryRecord | null>
  /** Atomically commits new hashes or deletes existing under expected revision. */
  commit: (
    sub: string,
    expectedRevision: string | null,
    next: RecoveryRecord | null,
  ) => Promise<boolean>
}

export type RecoveryStoreDeclaration<Env = unknown> = StoreDeclaration<RecoveryStore, Env>

export interface SqlRecoveryOptions<Recovery = unknown> {
  readonly database: ResourceAssembly
  readonly tables?: {
    readonly recovery?: Recovery
  }
}
