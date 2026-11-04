/**
 * Isomorphic page contracts, loader/action arguments, and layout metadata.
 *
 * @module
 */

import type { ComponentType, ReactNode } from 'react'

import type { BaseDeclaration } from '../app/declaration'
import type { RouteScope } from '../app/http/types'
import type { DefaultApi, HttpClient } from '../client/client'

/** Display identity for loaders and hydration; API authorization remains server-owned. */
export interface IdentitySnapshot {
  /** Authenticated user identity, or null if unauthenticated. */
  readonly user: {
    readonly sub: string
    readonly roles?: readonly string[]
    readonly displayName?: string
  } | null
}

/** Context and typed client provided to page loaders during SSR and navigation. */
export interface LoaderArgs<Params = Record<string, string | string[]>, Api = DefaultApi> {
  /** Bound HTTP client dispatching internally during SSR or over HTTP in the browser. */
  readonly client: HttpClient<Api>
  /** Parsed URL parameters according to the route pattern. */
  readonly params: Params
  /** Current requested URL. */
  readonly url: URL
  /** Abort signal cancelling execution when the navigation is aborted. */
  readonly signal: AbortSignal
  /** Display identity snapshot available at invocation time. */
  readonly identity: IdentitySnapshot
}

/** Context and form data provided to page action handlers. */
export interface ActionArgs<Params = Record<string, string | string[]>, Api = DefaultApi> {
  /** Bound HTTP client dispatching internally during SSR or over HTTP in the browser. */
  readonly client: HttpClient<Api>
  /** Form submission payload. */
  readonly formData: FormData
  /** Parsed URL parameters according to the route pattern. */
  readonly params: Params
  /** Abort signal cancelling execution when the action is aborted. */
  readonly signal: AbortSignal
}

/** Error payload delivered to scoped error boundaries. */
export interface PageError {
  /** HTTP status code (e.g. 404, 500). */
  readonly status?: number
  /** Error message. */
  readonly message: string
  /** Optional structured error details. */
  readonly data?: unknown
}

/** Action failure is separate from a successful write followed by a failed read. */
export interface ActionOutcome {
  readonly error?: PageError
  readonly revalidateError?: PageError
}

/** Execution state of a single route scope (layout or page). */
export type ScopeSnapshot =
  | { readonly status: 'success'; readonly data?: unknown }
  | { readonly status: 'error'; readonly error: PageError }
  | { readonly status: 'idle' }

/** Navigation lifecycle state. */
export interface NavigationState {
  readonly state: 'idle' | 'loading' | 'submitting'
}

/** Options for client-side navigation. */
export interface NavigateOptions {
  /** Replaces the current history entry instead of adding one; defaults to false. */
  readonly replace?: boolean
  /** Retains scroll on new navigation; native traversal still restores its saved position. */
  readonly preventScrollReset?: boolean
  /** Application state stored with the resulting browser history entry. */
  readonly state?: unknown
}

/** Leave guard: false rejects, true/void allows; asynchronous results are awaited. */
export type BlockerHandler = (args: {
  readonly currentUrl: URL
  readonly nextUrl: URL
  readonly signal: AbortSignal
}) => boolean | void | Promise<boolean | void>

/** Props passed to scoped `_error.tsx` components. */
export interface ErrorProps {
  /** Error raised during loader execution or rendering. */
  readonly error: PageError
  /** Retries the failed scope's loader, or rerenders it after a component-only failure. */
  retry(): void
}

/** Current state and submission control for `useAction`. */
export interface ActionResult<T> {
  /** Returned data from the last successful action execution. */
  readonly data: T | undefined
  /** Error raised during action execution. */
  readonly error: PageError | undefined
  /** Error raised during revalidation following a successful action. */
  readonly revalidateError: PageError | undefined
  /** True while the action submission or subsequent revalidation is in-flight. */
  readonly pending: boolean
  /** Submits form data to the action handler. */
  submit(formData: FormData): void
}

/** Arguments passed to `shouldRevalidate` to decide if a loader should rerun. */
export interface ShouldRevalidateArgs<Params = Record<string, string | string[]>> {
  /** Reason triggering the potential revalidation. */
  readonly reason: 'navigate' | 'action' | 'reload'
  /** Parameters of the currently displayed route. */
  readonly currentParams: Params
  /** URL of the currently displayed route. */
  readonly currentUrl: URL
  /** Parameters of the destination route. */
  readonly nextParams: Params
  /** Destination URL. */
  readonly nextUrl: URL
  /** Default revalidation recommendation. */
  readonly defaultShouldRevalidate: boolean
}

/** HTML link element descriptor for page head. */
export interface LinkDescriptor {
  /** Stable identity for overriding a link from an outer layout. */
  readonly key?: string
  readonly rel: string
  readonly href: string
  readonly type?: string
  readonly media?: string
  readonly as?: string
  readonly crossOrigin?: 'anonymous' | 'use-credentials' | ''
  readonly hreflang?: string
  readonly imagesrcset?: string
  readonly imagesizes?: string
  readonly [key: string]: string | undefined
}

/** HTML script element descriptor for page head. */
export interface ScriptDescriptor {
  /** Stable identity for overriding a script from an outer layout. */
  readonly key?: string
  readonly src?: string
  readonly type?: string
  readonly async?: boolean
  readonly defer?: boolean
  readonly crossOrigin?: 'anonymous' | 'use-credentials' | ''
  readonly content?: string
  readonly [key: string]: string | boolean | undefined
}

/** Document metadata returned by page and layout meta functions. */
export interface MetaDescriptor {
  /** Document title. */
  readonly title?: string
  /** Meta description. */
  readonly description?: string
  /** Canonical URL. */
  readonly canonical?: string
  /** Robots directive. */
  readonly robots?: string
  /** OpenGraph property map. */
  readonly openGraph?: Readonly<Record<string, string>>
  /** Twitter card metadata. */
  readonly twitter?: Readonly<Record<string, string>>
  /** Ordered list of link elements. */
  readonly links?: readonly LinkDescriptor[]
  /** Ordered list of script elements. */
  readonly scripts?: readonly ScriptDescriptor[]
}

/** Context provided to page and layout meta functions. */
export interface MetaArgs<Data = unknown, Params = Record<string, string | string[]>> {
  /** Loader data resolved for this scope. */
  readonly data: Data
  /** Route parameters. */
  readonly params: Params
  /** Current URL. */
  readonly url: URL
}

/** Page cache declaration options. */
export interface PageCacheConfig {
  /** Public response freshness lifetime in seconds; does not enable instance storage. */
  readonly ttl?: number
  /** Stale-while-revalidate duration in seconds. */
  readonly staleWhileRevalidate?: number
  /** Cache tags for tag-based invalidation. */
  readonly tags?:
    | readonly string[]
    | ((params: Record<string, string | string[]>) => readonly string[])
  /** Request headers to vary cache on. */
  readonly vary?: readonly string[]
}

/** Remote API endpoint settings for separated deployments. */
export interface PageApiConfig {
  /** Trusted absolute HTTP(S) API base, without query, fragment, or URL credentials. */
  readonly serverUrl: string | undefined
  /**
   * Public API base without query, fragment, or URL credentials; relative paths are allowed.
   * Defaults to the resolved engineering API prefix.
   */
  readonly browserUrl?: string
  /** Browser fetch credentials mode; defaults to same-origin. */
  readonly credentials?: RequestCredentials
}

/** Callback mapping request context to an initial display identity snapshot. */
export type PageIdentityResolver<Api = DefaultApi> = (args: {
  readonly client: HttpClient<Api>
  readonly signal: AbortSignal
}) => Promise<IdentitySnapshot> | IdentitySnapshot

/** Options configuring fullstack page runtime and API dispatch. */
export interface PageConfig<Api = DefaultApi> {
  /** Remote API transport; omit for in-process dispatch without a network loopback. */
  readonly api?: PageApiConfig
  /** Custom identity snapshot mapper evaluated during SSR. */
  readonly identity?: PageIdentityResolver<Api>
}

/** Internal wrapper for application page declarations. */
export interface PageDeclaration<Api = DefaultApi> extends BaseDeclaration<
  'page',
  PageConfig<Api>
> {}

/**
 * Execution contract for heterogeneous page modules.
 * Generated tables retain each import's concrete type with `satisfies`;
 * parameter and data types are erased only when dispatching a matched module.
 */
export interface RuntimePageModule {
  default: ComponentType<any>
  loader?: (args: LoaderArgs<any, any>) => unknown
  action?: (args: ActionArgs<any, any>) => unknown
  meta?: (args: MetaArgs<any, any>) => MetaDescriptor
  cache?: PageCacheConfig | false
  shouldRevalidate?: (args: ShouldRevalidateArgs<any>) => boolean
}

/** Scope descriptor used for server-side rendering and pipeline assembly. */
export interface ServerPageScope {
  /** Scope identifier. */
  readonly id: string
  /** Component function (layout or page). Required on server. */
  readonly component: RuntimePageModule['default']
  /** Optional error presentation component. */
  readonly errorComponent?: ComponentType<{ error: PageError; retry(): void }>
  /** Optional server loader function. */
  readonly loader?: RuntimePageModule['loader']
  /** Optional meta descriptor generator. */
  readonly meta?: RuntimePageModule['meta']
  /** Optional cache configuration. */
  readonly cache?: PageCacheConfig | false
  /** Custom revalidation decider. */
  readonly shouldRevalidate?: RuntimePageModule['shouldRevalidate']
}

/** Route specification for server-side page handling and middleware execution. */
export interface ServerPageRoute {
  /** Route path pattern (e.g. `/posts/:id`). */
  readonly pattern: string
  /** Canonical path shape identifying routes independently of parameter names. */
  readonly shapeKey: string
  /** Parameter names extracted from pattern. */
  readonly paramNames: readonly string[]
  /** Root document component. */
  readonly rootComponent?: ComponentType<{ children?: ReactNode }>
  /** Ordered Hono middleware chain from root down to page level. */
  readonly httpScopes: readonly RouteScope[]
  /** Ordered scopes from root layout to leaf page component. */
  readonly scopes: readonly ServerPageScope[]
}
