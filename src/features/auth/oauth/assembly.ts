/** Independent OAuth assembly; it does not load first-party sessions. */
import type { EnvironmentRequirement } from '../../../app/declaration'
import type { RouteEntry } from '../../../app/http/assembly'
import type { ServiceAssembly, ServiceRuntime } from '../../../app/service'
import type { DiscoveryCache } from './client'
import { resolveOAuthProviders } from './config'
import { createOAuthRoutes, type OAuthRequestState } from './routes'
import type { OAuthDeclaration, ResolvedOAuthProvider } from './types'

/** Defers OAuth setup with the resolved API prefix and declaration environment requirements. */
export function createOAuthAssembly<T extends OAuthDeclaration>(
  input: T,
  apiPrefix: string,
): ServiceAssembly & EnvironmentRequirement<readonly [T]>
export function createOAuthAssembly(input: OAuthDeclaration, apiPrefix: string): ServiceAssembly {
  return { createRuntime: () => createOAuthRuntime(input, apiPrefix) }
}

/** Owns one application's discovery cache and its latest compiled endpoint descriptions. */
function createOAuthRuntime(input: OAuthDeclaration, apiPrefix: string): ServiceRuntime<never> {
  const discovery: DiscoveryCache = new Map()
  let staticProviders: ReadonlyMap<string, ResolvedOAuthProvider> | undefined
  let endpoints: { key: string; routes: RouteEntry[] } | undefined
  return {
    prepare(env, config) {
      const secret = config.cookie.secret
      if (!secret || secret.length < 16)
        throw new Error('OAuth requires app.cookie.secret with at least 16 characters.')
      let providers = staticProviders
      if (!providers) {
        const resolved = resolveOAuthProviders(input.value, env, apiPrefix)
        providers = new Map(resolved.map((provider) => [provider.id, provider]))
        for (const id of discovery.keys()) if (!providers.has(id)) discovery.delete(id)
        const key = JSON.stringify(
          resolved.map((provider) => [
            provider.id,
            provider.signInPath,
            provider.callbackMethod,
            provider.callbackPath,
          ]),
        )
        if (endpoints?.key !== key) endpoints = { key, routes: createOAuthRoutes(resolved) }
        if (!input.isFactory) staticProviders = providers
      }
      const state: OAuthRequestState = {
        providers,
        secret,
        production: config.production,
        discovery,
      }
      return {
        routes: endpoints!.routes,
        create: () => ({ createBinding: () => ({ state }) }),
      }
    },
  }
}
