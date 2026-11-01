/** Public session contracts shared with application code and optional authentication factors. */
import type { AuthFacts, Identity } from '../contracts'

/** Input required to issue a new session token. */
export interface SignInInput {
  /** Unique subject identifier. */
  readonly sub: string
  /** Credentials version number; defaults to 0. */
  readonly ver?: number
  /** Authentication Methods References. */
  readonly amr?: readonly string[]
  /** Time of initial authentication in Unix seconds. */
  readonly authTime?: number
  /** Application roles granted to this identity. */
  readonly roles?: readonly string[]
  /** Specific factor authentication facts. */
  readonly auth?: AuthFacts
  /** Custom unreserved claims to attach to the token. */
  readonly claims?: Readonly<Record<string, unknown>>
}

/** Issued session containing the resolved identity and signed JWT. */
export interface IssuedSession {
  /** Resolved identity representation. */
  readonly identity: Identity
  /** Cryptographically signed JWT string. */
  readonly token: string
}

/** Delivery options supplied when issuing a session. */
export interface SessionOptions {
  /**
   * Whether to deliver the session token in an HttpOnly cookie.
   * Defaults to `true`. When `false`, the token is only returned to the caller.
   */
  readonly cookie?: boolean
}

/** Request-level authentication handle exposed on `ctx.var.auth`. */
export interface RequestAuth {
  /** Current authenticated identity, or null if unauthenticated. */
  readonly identity: Identity | null
  /**
   * Issues a new session token, sets the session cookie by default, and returns the session.
   *
   * @param input - Identity claims for the new session.
   * @param options - Session delivery overrides.
   * @returns The newly issued session.
   * @throws If the identity input is invalid or response headers have already been committed.
   */
  signIn(input: SignInInput, options?: SessionOptions): Promise<IssuedSession>
  /**
   * Clears the session cookie and current identity without revoking copied tokens.
   *
   * @returns Resolves after the deletion Set-Cookie header has been added to the pending response.
   * @throws If response headers have already been committed.
   */
  signOut(): Promise<void>
}

/** Public application-level authentication service exposed on `instance.auth`. */
export interface AuthService {
  /**
   * Verifies a raw JWT against cryptographic constraints and validation hooks.
   *
   * @param token - Raw JWT string.
   * @param options - Optional request and cancellation signal supplied to application hooks.
   * @returns Validated identity, or null if invalid, expired, or revoked.
   * @throws If an account validation hook or its dependency fails.
   */
  verify(
    token: string,
    options?: { readonly request?: Request; readonly signal?: AbortSignal },
  ): Promise<Identity | null>

  /**
   * Extracts and validates credentials from an incoming Request (Authorization Bearer or Cookie).
   *
   * @param request - Incoming HTTP request.
   * @returns Validated identity, or null if unauthenticated.
   * @throws If an account validation hook or its dependency fails.
   */
  authenticate(request: Request): Promise<Identity | null>
}
