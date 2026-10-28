/**
 * First-party authentication and session management entrypoint for Sark applications.
 *
 * @module
 */

export { signToken, verifyToken } from '../../services/auth/session/token'
export { requireStepUp, type StepUpOptions } from '../../services/auth/guard'
export {
  defineAuth,
  type AuthDeclaration,
  type AuthConfig,
  type SessionCookieConfig,
  type SigningConfig,
  type SigningKeyConfig,
} from '../../services/auth/session/config'
export type {
  AuthCheckContext,
  AuthenticationFacts,
  Identity,
  SigningCredentials,
  SigningKey,
} from '../../services/auth/contracts'
export type {
  AuthService,
  IssuedSession,
  RequestAuth,
  SessionOptions,
  SignInInput,
} from '../../services/auth/session/types'
