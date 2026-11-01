/** TOTP persistence and default tables for Cloudflare D1. */
export { sqlTotp } from '../../services/auth/totp/db/d1'
export { factors as totpFactors } from '../../services/auth/totp/schema/sqlite'
