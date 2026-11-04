/**
 * First-party authentication and session management entrypoint for Sark applications.
 *
 * @module
 */

export {
  defineAuth,
  type AuthDeclaration,
  type AuthConfig,
  type SessionCookieConfig,
  type SigningConfig,
  type SigningKeyConfig,
} from '../features/auth/session/config'

export { signToken, verifyToken } from '../features/auth/session/token'
export { requireStepUp, type StepUpOptions } from '../features/auth/guard'

export type {
  AuthCheckContext,
  AuthFacts,
  Identity,
  SigningCredentials,
  SigningKey,
} from '../features/auth/contracts'
export type {
  AuthService,
  IssuedSession,
  RequestAuth,
  SessionOptions,
  SignInInput,
} from '../features/auth/session/types'
