/** Shared authentication state persistence and default tables for PostgreSQL. */
export { sqlAuthState } from '../../services/auth/state/postgres'
export {
  challenges as mfaChallenges,
  attempts as mfaAttempts,
} from '../../services/auth/state/schema/postgres'
