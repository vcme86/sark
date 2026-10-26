/**
 * React context delivering route state, typed client, and navigation controllers.
 *
 * @module
 */

import { createContext, type ReactNode, useContext } from 'react'

import type { HttpClient } from '../http/client/client'
import type { ActionArgs, IdentitySnapshot, MetaDescriptor, PageError } from './types'

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

/** Complete page context value provided to the React component tree. */
export interface PageContextValue {
  /** Bound HTTP client dispatching internally during SSR or over network in browser. */
  readonly client: HttpClient<any>
  /** Current active URL. */
  readonly url: URL
  /** Parameters matching the current route. */
  readonly params: Readonly<Record<string, string | string[]>>
  /** Active identity snapshot. */
  readonly identity: IdentitySnapshot
  /** Map of scope ID to its resolved snapshot. */
  readonly scopes: Readonly<Record<string, ScopeSnapshot>>
  /** Current navigation state (idle/loading/submitting). */
  readonly navigation: NavigationState
  /** Initiates client navigation to the destination path. */
  navigate(to: string, options?: NavigateOptions): Promise<{ committed: boolean }>
  /** Reloads loaders for the current matched route hierarchy. */
  reload(): Promise<void>
  /** Retries one failed loader or rerenders its component-only failure. */
  retryScope(scopeId: string): Promise<void>
  /** Updates the active identity snapshot in the browser. */
  setIdentity(snapshot: IdentitySnapshot): void
  /** Runs an Action under the same ownership as navigation and revalidation. */
  submitAction?<T>(
    handler: (args: ActionArgs<any, any>) => T | Promise<T>,
    formData: FormData,
    success: (data: T) => void,
    signal: AbortSignal,
  ): Promise<{ error?: PageError; revalidateError?: PageError }>
  /** Registers a navigation blocker function. */
  registerBlocker(id: string, handler: BlockerHandler): void
  /** Unregisters a navigation blocker function. */
  unregisterBlocker(id: string): void
  /** Merged document metadata for the current route. */
  readonly meta: MetaDescriptor
  /** Ordered route components to render for each depth of Outlet. */
  readonly outletChain: readonly ReactNode[]
  /** Pre-serialized bootstrap payload JSON string (for <Scripts />). */
  readonly bootstrapJson?: string
}

const PageContext = createContext<PageContextValue | null>(null)

/** Depth context for nested Outlet rendering. */
export const OutletDepthContext = createContext<number>(0)

/**
 * Reads the active page context from the component tree.
 *
 * @returns The current provider's page state and browser operations.
 * @throws {Error} If the component is outside a page provider.
 */
export function usePageContext(): PageContextValue {
  const context = useContext(PageContext)
  if (!context) {
    throw new Error('usePageContext must be used within a Sark PageProvider.')
  }
  return context
}

/** Optional accessor for page context without throwing when outside. */
export function useOptionalPageContext(): PageContextValue | null {
  return useContext(PageContext)
}

/** Props for the root PageProvider. */
export interface PageProviderProps {
  readonly value: PageContextValue
  readonly children?: ReactNode
}

/** Delivers page execution state to the React component tree. */
export function PageProvider({ value, children }: PageProviderProps) {
  return <PageContext.Provider value={value}>{children}</PageContext.Provider>
}
