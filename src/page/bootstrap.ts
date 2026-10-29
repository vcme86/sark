import type { UrlPolicy } from '../http/url'
import type { IdentitySnapshot, ScopeSnapshot } from './types'

/** Public build settings and request results exchanged between SSR and hydration. */
export interface BootstrapData {
  readonly policy: UrlPolicy
  readonly build: {
    readonly api: { readonly browserUrl: string; readonly credentials: RequestCredentials }
    readonly styles: Readonly<Record<string, readonly string[]>>
    readonly visitor?: { readonly path: string }
  }
  readonly request: {
    readonly url: string
    readonly params: Record<string, string | string[]>
    readonly identity: IdentitySnapshot
    readonly scopes: Record<string, ScopeSnapshot>
  }
}
