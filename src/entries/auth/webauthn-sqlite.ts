/** WebAuthn persistence and default tables for SQLite. */
export { sqlWebAuthn } from '../../services/auth/webauthn/db/sqlite'
export {
  subjects as webauthnSubjects,
  credentials as webauthnCredentials,
} from '../../services/auth/webauthn/schema/sqlite'
