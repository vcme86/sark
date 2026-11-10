import type { UrlPolicy } from '../http/url'
import type { IdentitySnapshot, ScopeSnapshot } from './types'

/** Request data and runtime browser settings required to hydrate the document. */
export interface BootstrapData {
  readonly config?: {
    readonly api?: { readonly browserUrl?: string; readonly credentials?: RequestCredentials }
    readonly policy?: Partial<UrlPolicy>
    readonly visitorPath?: string
  }
  readonly request: {
    readonly identity?: IdentitySnapshot
    readonly scopes: Record<string, ScopeSnapshot>
  }
}
