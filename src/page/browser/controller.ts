import type { HttpClient } from '../../client/client'
import { canonicalPathname, normalizeUrlPath, type UrlPolicy } from '../../http/url'
import type { BootstrapData } from '../bootstrap'
import { toPageError } from '../errors'
import { matchClientRoute } from '../match'
import { mergeMetaDescriptors } from '../meta'
import { RedirectSignal } from '../signals'
import type {
  ActionArgs,
  ActionOutcome,
  BlockerHandler,
  IdentitySnapshot,
  MetaDescriptor,
  NavigateOptions,
  NavigationState,
  PageError,
  ScopeSnapshot,
} from '../types'
import { type ClientRoute, prepareClientRoute } from './route'

/** A committed view; pending operations never mutate its scope results. */
interface PageView {
  readonly route: ClientRoute
  readonly url: URL
  readonly params: Record<string, string | string[]>
  readonly identity: IdentitySnapshot
  readonly scopes: Readonly<Record<string, ScopeSnapshot>>
  readonly meta: MetaDescriptor
  readonly revision: number
  readonly resetScopes?: ReadonlySet<string>
}

/** Browser history entry selected by a native back/forward traversal. */
export interface HistoryTarget {
  readonly index: number
  readonly scroll: readonly [number, number]
  readonly focus?: string
}

/** Browser history and document operations used by the navigation controller. */
export interface NavigationHost {
  commit(
    url: URL,
    options: NavigateOptions,
    target: HistoryTarget | undefined,
    owns: () => boolean,
  ): Promise<void>
  restore(target: HistoryTarget): Promise<void>
  hardNavigate(url: URL): void
  report(error: unknown): void
}

/**
 * Coordinates browser navigation, loader reads, and actions.
 * Only the current operation may commit a view, change history, or end the
 * loading/submitting state; cancellation does not roll back application writes.
 */
export class PageController {
  private operation?: AbortController
  private listeners = new Set<() => void>()
  private blockers = new Map<string, BlockerHandler>()
  private snapshot: { view: PageView; navigation: NavigationState }

  /**
   * Initializes navigation from the server's prepared route modules and scope results.
   *
   * @param routes - Generated routes ordered by matching priority.
   * @param client - Browser API client supplied to loaders and actions.
   * @param host - History, document navigation, and error-reporting operations.
   * @param styles - Build-owned styles keyed by route pattern.
   * @param initial - Server scope results and identity, with the actual browser document URL.
   * @param policy - Resolved URL matching and slash policy delivered with the document.
   * @throws {Error} If the initial document has no matching browser route.
   */
  constructor(
    private readonly routes: readonly ClientRoute[],
    private readonly client: HttpClient<unknown>,
    private readonly host: NavigationHost,
    private readonly styles: BootstrapData['build']['styles'],
    initial: BootstrapData['request'],
    private readonly policy: UrlPolicy,
  ) {
    const url = new URL(initial.url)
    const match = matchClientRoute(routes, url.pathname, policy.caseSensitive)
    if (!match) throw new Error('The initial document has no matching browser route.')
    const view = {
      route: match.route,
      url,
      params: initial.params,
      identity: initial.identity,
      scopes: initial.scopes,
      revision: 0,
    }
    this.snapshot = { view: { ...view, meta: this.metadata(view) }, navigation: { state: 'idle' } }
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  registerBlocker = (id: string, handler: BlockerHandler): void => {
    this.blockers.set(id, handler)
  }

  unregisterBlocker = (id: string): void => {
    this.blockers.delete(id)
  }

  hasBlockers = (): boolean => this.blockers.size > 0

  /**
   * Prepares matched route modules and CSS without running loaders or changing the view.
   *
   * @param to - Destination URL, resolved against the current committed view.
   * @returns A promise resolving after preparation; external or unmatched destinations do nothing.
   */
  prefetch = async (to: string): Promise<void> => {
    const destination = new URL(to, this.snapshot.view.url)
    if (destination.origin !== this.snapshot.view.url.origin || destination.pathname.includes('//'))
      return
    if (isHashNavigation(this.snapshot.view.url, destination)) return
    const match = matchClientRoute(this.routes, destination.pathname, this.policy.caseSensitive)
    if (match) await prepareClientRoute(match.route)
  }

  /** Changes the display identity and invalidates pending work without rerunning loaders. */
  setIdentity = (identity: IdentitySnapshot): void => {
    this.operation?.abort()
    this.operation = undefined
    this.publish({ ...this.snapshot.view, identity }, 'idle')
  }

  /** Signals cancellation of the active operation and removes state subscribers. */
  dispose(): void {
    this.operation?.abort()
    this.operation = undefined
    this.listeners.clear()
  }

  /**
   * Runs leave guards, prepares the target route, and commits only while it owns navigation.
   * Unmatched destinations use native document navigation; loader redirects replace history.
   *
   * @param to - Destination URL, resolved against the current committed view.
   * @param options - History replacement, caller state, and scroll-reset options.
   * @param target - Existing history entry selected by Back/Forward, absent for new navigation.
   * @returns Whether the destination became the committed client view.
   */
  navigate = async (
    to: string,
    options: NavigateOptions = {},
    target?: HistoryTarget,
  ): Promise<{ committed: boolean }> => {
    const destination = new URL(to, this.snapshot.view.url)
    const operation = this.begin(
      isHashNavigation(this.snapshot.view.url, destination) ? 'idle' : 'loading',
    )
    try {
      return await this.navigateOwned(operation, destination, options, target)
    } finally {
      this.finish(operation)
    }
  }

  /** Reruns all current loaders, regardless of shouldRevalidate, under a new operation. */
  reload = async (): Promise<void> => {
    const operation = this.begin('loading')
    try {
      await this.revalidate(operation, 'reload')
    } finally {
      this.finish(operation)
    }
  }

  /**
   * Retries one failed loader or clears a component-only failure without rerunning other loaders.
   *
   * @param id - Failed scope identifier in the current route hierarchy.
   * @returns A promise resolving after the scope retry settles.
   */
  retryScope = async (id: string): Promise<void> => {
    const operation = this.begin('loading')
    try {
      await this.revalidate(operation, 'reload', id)
    } finally {
      this.finish(operation)
    }
  }

  /**
   * Runs an action and its subsequent loader revalidation as one browser operation.
   *
   * Submission order:
   * 1. Invalidate the previous operation and invoke the action with its cancellation signal.
   * 2. Publish successful action data only if this operation is still current.
   * 3. Revalidate loaders and report read failures separately from action failures.
   *
   * @param handler - Application action; redirects are handled by browser navigation.
   * @param formData - Submission fields supplied by the caller.
   * @param success - Receives successful data before revalidation starts.
   * @param signal - Submission cancellation signal, including component unmount.
   * @returns Action or revalidation errors; superseded operations return an empty outcome.
   */
  submitAction = async <T>(
    handler: (args: ActionArgs<any, any>) => T | Promise<T>,
    formData: FormData,
    success: (data: T) => void,
    signal: AbortSignal,
  ): Promise<ActionOutcome> => {
    const operation = this.begin('submitting')
    const current = this.snapshot.view
    const cancel = () => {
      this.finish(operation)
      operation.abort()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      let data: T
      try {
        data = await handler({
          client: this.client,
          formData,
          params: current.params,
          signal: operation.signal,
        })
      } catch (error) {
        if (!this.owns(operation)) return {}
        if (error instanceof RedirectSignal) {
          await this.navigateOwned(operation, new URL(error.url, current.url), { replace: true })
          return {}
        }
        return { error: toPageError(error) }
      }
      if (!this.owns(operation)) return {}
      success(data)
      const error = await this.revalidate(operation, 'action')
      return this.owns(operation) ? { revalidateError: error } : {}
    } finally {
      signal.removeEventListener('abort', cancel)
      this.finish(operation)
    }
  }

  private publish(view: PageView, state: NavigationState['state']): void {
    this.snapshot = { view, navigation: { state } }
    for (const listener of this.listeners) listener()
  }

  private begin(state: NavigationState['state']): AbortController {
    this.operation?.abort()
    const operation = new AbortController()
    this.operation = operation
    this.publish(this.snapshot.view, state)
    return operation
  }

  private owns(operation: AbortController): boolean {
    return this.operation === operation && !operation.signal.aborted
  }

  private finish(operation: AbortController): void {
    if (!this.owns(operation)) return
    this.operation = undefined
    if (this.snapshot.navigation.state !== 'idle') this.publish(this.snapshot.view, 'idle')
  }

  private async navigateOwned(
    operation: AbortController,
    destination: URL,
    options: NavigateOptions,
    target?: HistoryTarget,
  ): Promise<{ committed: boolean }> {
    try {
      for (const blocker of this.blockers.values()) {
        const allowed = await blocker({
          currentUrl: this.snapshot.view.url,
          nextUrl: destination,
          signal: operation.signal,
        })
        if (!this.owns(operation) || allowed === false) {
          if (target && this.owns(operation)) await this.host.restore(target)
          return { committed: false }
        }
      }
      const visited = new Set<string>()
      while (this.owns(operation)) {
        if (visited.has(destination.href)) throw new Error('Page redirect loop.')
        visited.add(destination.href)
        if (
          destination.origin === this.snapshot.view.url.origin &&
          destination.pathname.includes('//')
        ) {
          this.host.hardNavigate(destination)
          return { committed: false }
        }
        const hashOnly = isHashNavigation(this.snapshot.view.url, destination)
        const match = hashOnly
          ? { route: this.snapshot.view.route, params: this.snapshot.view.params }
          : destination.origin === this.snapshot.view.url.origin
            ? matchClientRoute(this.routes, destination.pathname, this.policy.caseSensitive)
            : null
        if (!match) {
          this.host.hardNavigate(destination)
          return { committed: false }
        }
        destination = normalizeUrlPath(
          destination,
          this.policy.caseSensitive
            ? destination.pathname
            : canonicalPathname(destination.pathname, match.route.pattern),
          this.policy.trailingSlash,
        )
        try {
          if (!hashOnly) {
            if (this.snapshot.navigation.state !== 'loading')
              this.publish(this.snapshot.view, 'loading')
            await prepareClientRoute(match.route)
          }
          if (!this.owns(operation)) break
          const result = await this.read(
            operation,
            match.route,
            destination,
            match.params,
            'navigate',
          )
          if (!this.owns(operation)) break
          await this.host.commit(destination, options, target, () => this.owns(operation))
          if (!this.owns(operation)) break
          this.publish(result.view, 'idle')
          return { committed: true }
        } catch (error) {
          if (!this.owns(operation)) break
          if (error instanceof RedirectSignal) {
            destination = new URL(error.url, destination)
            options = { ...options, replace: true }
            continue
          }
          // A fresh server document can recover from unavailable target chunks.
          this.host.report(error)
          this.host.hardNavigate(destination)
          return { committed: false }
        }
      }
    } catch (error) {
      if (this.owns(operation)) this.host.report(error)
    }
    if (target && this.owns(operation)) await this.host.restore(target)
    return { committed: false }
  }

  private async revalidate(
    operation: AbortController,
    reason: 'reload' | 'action',
    retryId?: string,
  ): Promise<PageError | undefined> {
    const current = this.snapshot.view
    try {
      const result = await this.read(
        operation,
        current.route,
        current.url,
        current.params,
        reason,
        retryId,
      )
      if (!this.owns(operation)) return
      this.publish(result.view, reason === 'action' ? 'submitting' : 'loading')
      return result.error
    } catch (error) {
      if (!this.owns(operation)) return
      if (error instanceof RedirectSignal) {
        await this.navigateOwned(operation, new URL(error.url, current.url), { replace: true })
        return
      }
      this.host.report(error)
      return toPageError(error)
    }
  }

  private async read(
    operation: AbortController,
    route: ClientRoute,
    url: URL,
    params: PageView['params'],
    reason: 'navigate' | 'action' | 'reload',
    retryId?: string,
  ): Promise<{ view: PageView; error?: PageError }> {
    const current = this.snapshot.view
    const hashOnly = reason === 'navigate' && isHashNavigation(current.url, url)
    const scopes: Record<string, ScopeSnapshot> = {}
    let firstError: PageError | undefined
    const executed = new Set<string>()
    const defaultShouldRevalidate =
      reason !== 'navigate' ||
      current.url.pathname !== url.pathname ||
      current.url.search !== url.search
    const results = await Promise.all(
      route.scopes.map(async (scope) => {
        const previous = current.scopes[scope.id]
        const missing = !previous || previous.status === 'idle'
        try {
          const execute =
            scope.loader &&
            (retryId !== undefined
              ? scope.id === retryId && previous?.status === 'error'
              : missing ||
                reason === 'reload' ||
                (scope.shouldRevalidate
                  ? scope.shouldRevalidate({
                      reason,
                      currentParams: current.params,
                      currentUrl: current.url,
                      nextParams: params,
                      nextUrl: url,
                      defaultShouldRevalidate,
                    })
                  : defaultShouldRevalidate))
          if (!execute) {
            scopes[scope.id] =
              retryId === scope.id && !scope.loader && previous?.status === 'error'
                ? { status: 'success' }
                : (previous ?? { status: 'success' })
            return
          }
          executed.add(scope.id)
          if (hashOnly && this.owns(operation) && this.snapshot.navigation.state !== 'loading') {
            this.publish(current, 'loading')
          }
          const data = await scope.loader!({
            client: this.client,
            params,
            url,
            identity: current.identity,
            signal: operation.signal,
          })
          scopes[scope.id] = { status: 'success', data }
        } catch (error) {
          if (error instanceof RedirectSignal) return error
          const failure = toPageError(error)
          scopes[scope.id] = { status: 'error', error: failure }
        }
      }),
    )
    operation.signal.throwIfAborted()
    const redirect = results.find((result) => result instanceof RedirectSignal)
    if (redirect) throw redirect
    const view = {
      route,
      url,
      params,
      identity: current.identity,
      scopes,
      revision: current.revision + 1,
      resetScopes: retryId !== undefined ? new Set([retryId]) : hashOnly ? executed : undefined,
    }
    // Scope-local metadata failures preserve successful outer loaders.
    for (const scope of route.scopes) {
      const snapshot = scopes[scope.id]
      if (executed.has(scope.id) && snapshot?.status === 'error' && !firstError)
        firstError = snapshot.error
    }
    const meta = this.metadata(view, (id, error) => {
      const failure = toPageError(error)
      firstError ??= failure
      scopes[id] = { status: 'error', error: failure }
      this.host.report(error)
    })
    return { view: { ...view, meta }, error: firstError }
  }

  private metadata(
    view: Omit<PageView, 'meta'>,
    failed?: (id: string, error: unknown) => void,
  ): MetaDescriptor {
    const descriptors = view.route.scopes.map((scope) => {
      const snapshot = view.scopes[scope.id]
      if (!scope.meta || snapshot?.status !== 'success') return undefined
      try {
        return scope.meta({ data: snapshot.data, params: view.params, url: view.url })
      } catch (error) {
        if (!failed || error instanceof RedirectSignal) throw error
        failed(scope.id, error)
        return undefined
      }
    })
    return mergeMetaDescriptors([
      { links: this.styles[view.route.pattern]?.map((href) => ({ rel: 'stylesheet', href })) },
      ...descriptors,
    ])
  }
}

function isHashNavigation(current: URL, next: URL): boolean {
  return (
    current.origin === next.origin &&
    current.pathname === next.pathname &&
    current.search === next.search &&
    current.hash !== next.hash
  )
}
