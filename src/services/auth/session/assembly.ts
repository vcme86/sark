/** First-party session assembly selected by generated application code. */
import type { EnvironmentRequirement } from '../../../core/declaration'
import type {
  DomainAssembly,
  DomainRuntime,
  RequestBindingContext,
  ServiceBinding,
  ServiceInstanceResult,
} from '../../../core/service'
import { type AuthDeclaration, resolveAuthConfig, type ResolvedAuthConfig } from './config'
import { initRequestSession, type RequestAuthSessionState } from './request'
import {
  type AuthCacheStore,
  createAuthCacheStore,
  createAuthService,
  type InternalAuthService,
} from './service'
import type { AuthService } from './types'

/** Defers session initialization while retaining the declaration's environment requirements. */
export function createAuthAssembly<T extends AuthDeclaration>(
  input: T,
): DomainAssembly<AuthService> & EnvironmentRequirement<readonly [T]>
export function createAuthAssembly(input: AuthDeclaration): DomainAssembly<AuthService> {
  return { expose: true, createRuntime: () => createAuthRuntime(input) }
}

/** Owns one application's hook caches and resolves settings at its instance or event boundary. */
function createAuthRuntime(input: AuthDeclaration): DomainRuntime<AuthService> {
  const cache = createAuthCacheStore()
  return {
    prepare(env, config) {
      const options = resolveAuthConfig(input, env, config.production)
      return { create: (resources) => bindAuthService(options, resources, cache) }
    },
  }
}

/** Binds resolved resources to verification and the per-request session factory. */
function bindAuthService(
  options: ResolvedAuthConfig,
  resources: Readonly<Record<string, unknown>>,
  cache: AuthCacheStore,
): ServiceInstanceResult<AuthService> {
  const service = createAuthService(options, resources, cache)
  return {
    instanceService: { verify: service.verify, authenticate: service.authenticate },
    createBinding: (context) => createSessionBinding(service, context),
  }
}

/** Verifies or inherits the session before exposing its state and commit hook. */
async function createSessionBinding(
  service: InternalAuthService,
  context: RequestBindingContext,
): Promise<ServiceBinding> {
  const session = await initRequestSession(service, {
    request: context.request,
    signal: context.signal,
    parentSessionState: context.parentBinding?.state as RequestAuthSessionState | undefined,
    appendCookie: context.appendCookie,
    isHeadersCommitted: context.isHeadersCommitted,
  })
  context.ctx.set('auth', session.requestAuth)
  return {
    state: session.sessionState,
    csrfExempt: session.sessionState.isBearer,
    onCommitHeaders: session.onCommitHeaders,
  }
}
