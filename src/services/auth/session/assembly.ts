/** First-party session assembly selected by generated application code. */
import type { EnvironmentRequirement } from '../../../core/declaration'
import type {
  RequestBindingContext,
  ServiceAssembly,
  ServiceBinding,
  ServiceInitResult,
  ServiceRuntime,
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
): ServiceAssembly<AuthService> & EnvironmentRequirement<readonly [T]>
export function createAuthAssembly(input: AuthDeclaration): ServiceAssembly<AuthService> {
  return { expose: true, createRuntime: () => createAuthRuntime(input) }
}

/** Owns one application's hook caches and resolves settings at its instance or event boundary. */
function createAuthRuntime(input: AuthDeclaration): ServiceRuntime<AuthService> {
  const cache = createAuthCacheStore()
  let staticConfig: ResolvedAuthConfig | undefined
  return {
    prepare(env, httpConfig) {
      const config = input.isFactory
        ? resolveAuthConfig(input.value, env, httpConfig.production)
        : (staticConfig ??= resolveAuthConfig(input.value, env, httpConfig.production))
      return { create: (resources) => bindAuthService(config, resources, cache) }
    },
  }
}

/** Binds resolved resources to verification and the per-request session factory. */
function bindAuthService(
  config: ResolvedAuthConfig,
  resources: Readonly<Record<string, unknown>>,
  cache: AuthCacheStore,
): ServiceInitResult<AuthService> {
  const service = createAuthService(config, resources, cache)
  return {
    service: { verify: service.verify, authenticate: service.authenticate },
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
