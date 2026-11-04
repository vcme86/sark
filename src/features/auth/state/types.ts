/**
 * Contracts for authentication challenges and account attempt limits.
 *
 * @module
 */
import type { ResourceAssembly } from '../../../app/resource'
import type { StoreDeclaration } from '../store'

export type AuthFlowPurpose =
  | 'sign-in'
  | 'step-up'
  | 'enroll-totp'
  | 'enroll-webauthn'
  | 'webauthn-sign-in'

export type AuthFlowStatus = 'pending' | 'verifying' | 'consumed'

/** Ephemeral authentication flow shared by enrollment, sign-in, and step-up. */
export interface AuthFlow {
  readonly id: string
  readonly revision: string
  readonly purpose: AuthFlowPurpose
  readonly sub?: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly attempts: number
  readonly maxAttempts: number
  readonly status: AuthFlowStatus
  readonly claimId?: string
  readonly data: Record<string, unknown>
  /** Protocol expectations, bound once while this challenge is pending. */
  readonly protocol?: Readonly<Record<string, unknown>>
}

/** Account-level throttling parameters. */
export interface AuthAttemptLimit {
  readonly sub: string
  readonly purpose: string
  readonly window: number
  readonly maxAttempts: number
}

/** Result of claiming a challenge flow. */
export type ClaimResult =
  | { readonly status: 'claimed'; readonly flow: AuthFlow }
  | { readonly status: 'invalid' | 'limited'; readonly flow?: never }

/**
 * Store managing ephemeral challenge flows and account throttling windows.
 * Inputs are persisted by value; returned flows are detached snapshots, including data and protocol.
 */
export interface AuthStateStore {
  /** Inserts a challenge; returns false for an existing ID or exhausted capacity. */
  create: (flow: AuthFlow) => Promise<boolean>
  /** Reads current challenge state. Returns null if expired or missing. */
  read: (id: string) => Promise<AuthFlow | null>
  /**
   * Conditionally binds protocol options/parameters to the flow.
   * Returns updated flow, or existing valid flow on concurrent bind, or null if invalidated.
   */
  bindProtocol: (
    id: string,
    expectedRevision: string,
    protocol: Record<string, unknown>,
    now: number,
  ) => Promise<AuthFlow | null>
  /**
   * Atomically claims a pending challenge into verifying state, applying account throttling.
   * Returns 'limited' if account limit reached, 'invalid' if missing/expired/conflict, 'claimed' on success.
   */
  claim: (
    id: string,
    claimId: string,
    now: number,
    account?: AuthAttemptLimit,
  ) => Promise<ClaimResult>
  /** Releases a claimed flow back to pending if attempts < maxAttempts. Does not reset attempts. */
  release: (id: string, claimId: string, now: number) => Promise<boolean>
  /** Ends only the matching active claim; expiresAt must be strictly greater than now. */
  consume: (id: string, claimId: string, now: number) => Promise<boolean>
}

export type AuthStateStoreDeclaration<Env = unknown> = StoreDeclaration<AuthStateStore, Env>

export interface SqlAuthStateOptions<Challenges = unknown, AttemptWindows = unknown> {
  readonly database: ResourceAssembly
  readonly tables?: {
    readonly challenges?: Challenges
    readonly attemptWindows?: AttemptWindows
  }
}
