/**
 * Core visitor identity contracts and configuration.
 *
 * @module
 */

/** Visitor cookie scope and transport options. */
export interface VisitorCookieConfig {
  /** Cookie path scope; defaults to `'/'`. */
  readonly path?: string
  /** Cookie domain scope. */
  readonly domain?: string
  /** SameSite attribute; defaults to `'lax'`. */
  readonly sameSite?: 'lax' | 'strict' | 'none'
  /** Secure attribute; defaults to true in production or when SameSite is `'none'`. */
  readonly secure?: boolean
}

/** Configuration options for the visitors domain. */
export interface VisitorsConfig {
  /** Independent high-entropy signing secret containing at least 32 UTF-8 bytes. */
  readonly secret: string | undefined
  /** Cookie name used to persist the visitor identifier; defaults to `'visitor_id'`. */
  readonly cookieName?: string
  /** Lifetime of 1,000–34,560,000,000 milliseconds; defaults to 180 days (15,552,000,000 ms). */
  readonly expiresIn?: number
  /** Static initialization endpoint path; defaults to `'/__sark/visitor'`. */
  readonly path?: string
  /** Cookie scope and transport options. */
  readonly cookie?: VisitorCookieConfig
}

/** Fully resolved visitors settings with all defaults materialized. */
export interface ResolvedVisitorsConfig {
  readonly secret: string
  readonly cookieName: string
  readonly expiresIn: number
  readonly path: string
  readonly cookie: {
    readonly path: string
    readonly domain?: string
    readonly sameSite: 'lax' | 'strict' | 'none'
    readonly secure: boolean
    readonly httpOnly: boolean
  }
}

/**
 * Request-scoped visitor service exposed via `ctx.var.visitor`.
 * Await clear and ensure in sequence when replacing an identifier; clear does not cancel issuance.
 */
export interface RequestVisitor {
  /** Verified visitor identifier, or null if unassigned or expired. */
  readonly id: string | null

  /**
   * Returns the current visitor identifier, generating and signing a new one if missing.
   * Concurrent invocations on the same request coalesce into a single identifier issuance.
   *
   * @returns The active or newly assigned visitor UUID.
   * @throws {VisitorError} If a new cookie must be written but response headers are already committed.
   */
  ensure(): Promise<string>

  /**
   * Clears the current visitor identifier and marks the cookie for deletion.
   * Copied cookies remain valid until they expire; business data and login state are unchanged.
   *
   * @returns Resolves after queuing cookie deletion and clearing the current request's identifier.
   * @throws {VisitorError} If response headers are already committed.
   */
  clear(): Promise<void>
}
