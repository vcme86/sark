/** Public persistence records, independent of the optional WebAuthn SDK. */
import type { ResourceAssembly } from '../../../app/resource'

/** Stored WebAuthn credential record. */
export interface WebAuthnRecord {
  readonly credentialId: string
  readonly sub: string
  readonly userHandle: string
  readonly publicKey: Uint8Array
  readonly counter: number
  readonly transports?: readonly string[]
  readonly deviceType?: string
  readonly backedUp?: boolean
  readonly revision: string
  readonly createdAt: number
}

/** Store managing registered WebAuthn credentials and stable user handles. */
export interface WebAuthnStore {
  /** Gets existing stable userHandle or generates and persists a new one for sub. */
  getOrCreateUserHandle: (sub: string) => Promise<string>
  /** Finds a credential by its Base64URL-encoded credentialId. */
  findCredential: (credentialId: string) => Promise<WebAuthnRecord | null>
  /** Lists all credentials enrolled for a user. */
  listCredentials: (sub: string) => Promise<readonly WebAuthnRecord[]>
  /** Inserts a credential; returns false for an existing ID and throws on storage failure. */
  insertCredential: (credential: WebAuthnRecord) => Promise<boolean>
  /** Atomically updates counter and revision under expected revision. */
  updateCredential: (
    credentialId: string,
    sub: string,
    expectedRevision: string,
    next: WebAuthnRecord,
  ) => Promise<boolean>
  /** Removes a credential under expected revision. */
  removeCredential: (
    credentialId: string,
    sub: string,
    expectedRevision: string,
  ) => Promise<boolean>
}

export interface SqlWebAuthnOptions<Subjects = unknown, Credentials = unknown> {
  readonly database: ResourceAssembly
  readonly tables?: {
    readonly subjects?: Subjects
    readonly credentials?: Credentials
  }
}
