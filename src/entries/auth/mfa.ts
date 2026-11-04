export { defineMfa } from '../../features/auth/mfa/declaration'
export type { MfaDeclaration } from '../../features/auth/mfa/declaration'

export type {
  SignInPolicy,
  SignInPolicyResolver,
  SignInResult,
  MfaAccountLimitConfig,
  MfaChallengeConfig,
  MfaConfig,
  MfaRecoveryConfig,
  RequestMfa,
} from '../../features/auth/mfa/types'

export type { MemoryAuthStateConfig } from '../../features/auth/state/memory'
export { memoryState } from '../../features/auth/state/memory'

export type {
  AuthAttemptLimit,
  AuthFlow,
  AuthFlowPurpose,
  AuthFlowStatus,
  AuthStateStore,
  AuthStateStoreDeclaration,
  ClaimResult,
} from '../../features/auth/state/types'

export type {
  RecoveryCodeSet,
  RecoveryStore,
  RecoveryStoreDeclaration,
} from '../../features/auth/recovery/types'

export type { StoreContext, StoreDeclaration, StoreInitResult } from '../../features/auth/store'

export type { FactorKind, FactorProof } from '../../features/auth/factor'

export { AuthError } from '../../features/auth/error'
export type { AuthErrorCode } from '../../features/auth/error'
