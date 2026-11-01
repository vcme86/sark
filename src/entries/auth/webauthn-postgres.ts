/** WebAuthn persistence and default tables for PostgreSQL. */
export { sqlWebAuthn } from '../../services/auth/webauthn/db/postgres'
export {
  subjects as webauthnSubjects,
  credentials as webauthnCredentials,
} from '../../services/auth/webauthn/schema/postgres'
