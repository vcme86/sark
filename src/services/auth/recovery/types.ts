/**
 * Types and contracts for recovery code generation, verification, and persistence.
 *
 * @module
 */
import type { ResourceAssembly } from '../../../core/resource'
import type { StoreDeclaration } from '../store'

/** Versioned set of recovery code hashes for one subject. */
export interface RecoveryCodeSet {
  readonly revision: string
  readonly hashes: readonly string[]
}

/** Dedicated store managing hashed recovery codes with optimistic concurrency. */
export interface RecoveryStore {
  /** Reads the current recovery code set. Returns null if no set is stored. */
  read: (sub: string) => Promise<RecoveryCodeSet | null>
  /** Atomically commits new hashes or deletes existing under expected revision. */
  commit: (
    sub: string,
    expectedRevision: string | null,
    next: RecoveryCodeSet | null,
  ) => Promise<boolean>
}

export type RecoveryStoreDeclaration<Env = unknown> = StoreDeclaration<RecoveryStore, Env>

export interface SqlRecoveryOptions<CodeSets = unknown> {
  readonly database: ResourceAssembly
  readonly tables?: {
    readonly codeSets?: CodeSets
  }
}
