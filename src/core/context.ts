/**
 * AsyncLocalStorage scopes for request identity, cancellation, deduplication, and cookies.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import type { ResolvedHttpConfig } from '../web/http/config'
import type { AppInstance } from './types'

/** Execution scope metadata associated with an asynchronous call tree. */
export interface ExecutionScope {
  /** Request identifier shared by the root request and its internal calls. */
  readonly requestId: string
  /** Reference to the Sark application instance executing this scope. */
  readonly app?: AppInstance<any>
  /** Cancellation signal inherited by internal requests and asynchronous work. */
  readonly signal?: AbortSignal
  /** Whether this request was dispatched internally by the same application. */
  readonly isInternal?: boolean
  /** Collects cookies returned by internal requests into the outer response. */
  readonly appendCookies?: (cookies: readonly string[]) => void
  /** Marks streamed response headers as committed before rendering continues. */
  readonly commitResponseHeaders?: () => void
  /** Request-scoped cache shared by `dedup` wrappers. */
  readonly dedupStore?: Map<symbol, unknown>
  /** Resolved HTTP configuration in effect for this execution context. */
  readonly config?: ResolvedHttpConfig
  /** Client IP resolved from host metadata and trusted proxy forwarding. */
  readonly clientIp?: string
  /** Resolved external origin URL representing the public-facing application endpoint. */
  readonly externalOrigin?: string
  /** Environment bindings passed to current execution event. */
  readonly env?: unknown
  /** Platform execution context (e.g. Cloudflare Workers ExecutionContext). */
  readonly executionCtx?: unknown
  /** Resolved page configuration for fullstack page rendering. */
  readonly pageConfig?: unknown
}

/** HTTP state established by request middleware before dispatching business or page handlers. */
export interface RequestScope extends ExecutionScope {
  readonly signal: AbortSignal
  readonly config: ResolvedHttpConfig
  readonly clientIp: string
  readonly externalOrigin: string
  readonly appendCookies: NonNullable<ExecutionScope['appendCookies']>
  readonly commitResponseHeaders: NonNullable<ExecutionScope['commitResponseHeaders']>
}

const storage = new AsyncLocalStorage<ExecutionScope>()

/**
 * Runs a callback and its asynchronous work within the supplied scope.
 *
 * @param scope - The execution context to bind to the asynchronous call chain.
 * @param fn - Synchronous or asynchronous operation to execute.
 * @returns The return value of the callback.
 */
export function runInScope<R>(scope: ExecutionScope, fn: () => R): R {
  return storage.run(scope, fn)
}

/**
 * Runs without inheriting the caller's request scope, including its ID and dedup cache.
 * This only isolates context; it does not manage the callback's lifetime.
 *
 * @param fn - Operation to execute detached from the ambient context.
 * @returns The return value of the callback.
 */
export function runWithoutScope<R>(fn: () => R): R {
  return storage.exit(fn)
}

/**
 * Returns the active scope, or `undefined` outside scoped execution.
 *
 * @returns The active execution scope, or `undefined` if running outside an active scope.
 */
export function getCurrentScope(): ExecutionScope | undefined {
  return storage.getStore()
}

/**
 * Returns the active request ID, or `undefined` outside scoped execution.
 *
 * @returns The current request ID, or `undefined` outside a request scope.
 */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId
}
