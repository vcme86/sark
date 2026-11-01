/** WebAuthn persistence and default tables for Cloudflare D1. */
export { sqlWebAuthn } from '../../services/auth/webauthn/db/d1'
export {
  subjects as webauthnSubjects,
  credentials as webauthnCredentials,
} from '../../services/auth/webauthn/schema/sqlite'
