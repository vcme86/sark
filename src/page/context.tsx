/**
 * React context delivering route state, typed client, and navigation controllers.
 *
 * @module
 */

import { createContext, type ReactNode, useContext } from 'react'

import type { HttpClient } from '../client/client'
import type {
  ActionArgs,
  ActionOutcome,
  BlockerHandler,
  IdentitySnapshot,
  MetaDescriptor,
  NavigateOptions,
  NavigationState,
  ScopeSnapshot,
} from './types'

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
  /** Merged document metadata for the current route. */
  readonly meta: MetaDescriptor
  /** Stylesheets present in the initial document, retained by the browser after hydration. */
  readonly stylesheets: readonly string[]
  /** Ordered route components to render for each depth of Outlet. */
  readonly outletChain: readonly ReactNode[]
  /** Pre-serialized bootstrap payload JSON string (for <Scripts />). */
  readonly bootstrapJson?: string
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
  ): Promise<ActionOutcome>
  /** Registers a navigation blocker function. */
  registerBlocker(id: string, handler: BlockerHandler): void
  /** Unregisters a navigation blocker function. */
  unregisterBlocker(id: string): void
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
interface PageProviderProps {
  readonly value: PageContextValue
  readonly children?: ReactNode
}

/** Delivers page execution state to the React component tree. */
export function PageProvider({ value, children }: PageProviderProps) {
  return <PageContext.Provider value={value}>{children}</PageContext.Provider>
}
