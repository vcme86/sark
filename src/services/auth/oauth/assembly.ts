/** Independent OAuth assembly; it does not load first-party sessions. */
import type { EnvironmentRequirement } from '../../../core/declaration'
import type { DomainAssembly, DomainRuntime } from '../../../core/service'
import type { RouteEntry } from '../../../web/http/server/pipeline'
import type { DiscoveryCache } from './client'
import { resolveOAuthProviders } from './config'
import { createOAuthRoutes, type OAuthRequestState } from './routes'
import type { OAuthDeclaration } from './types'

/** Defers OAuth setup with the resolved API prefix and declaration environment requirements. */
export function createOAuthAssembly<T extends OAuthDeclaration>(
  input: T,
  apiPrefix: string,
): DomainAssembly & EnvironmentRequirement<readonly [T]>
export function createOAuthAssembly(input: OAuthDeclaration, apiPrefix: string): DomainAssembly {
  return { createRuntime: () => createOAuthRuntime(input, apiPrefix) }
}

/** Owns one application's discovery cache and its latest compiled endpoint descriptions. */
function createOAuthRuntime(input: OAuthDeclaration, apiPrefix: string): DomainRuntime<never> {
  const discovery: DiscoveryCache = new Map()
  let endpoints: { key: string; routes: RouteEntry[] } | undefined
  return {
    prepare(env, config) {
      const secret = config.cookie.secret
      if (!secret || secret.length < 16)
        throw new Error('OAuth requires app.cookie.secret with at least 16 characters.')
      const providers = resolveOAuthProviders(input, env, apiPrefix)
      const ids = new Set(providers.map((provider) => provider.id))
      for (const id of discovery.keys()) if (!ids.has(id)) discovery.delete(id)
      const key = JSON.stringify(
        providers.map((provider) => [
          provider.id,
          provider.signInPath,
          provider.callbackMethod,
          provider.callbackPath,
        ]),
      )
      if (endpoints?.key !== key) endpoints = { key, routes: createOAuthRoutes(providers) }
      const state: OAuthRequestState = {
        providers: new Map(providers.map((provider) => [provider.id, provider])),
        secret,
        production: config.production,
        discovery,
      }
      return {
        routes: endpoints.routes,
        create: () => ({ createBinding: () => ({ state }) }),
      }
    },
  }
}
