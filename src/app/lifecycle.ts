/**
 * Application lifecycle state, request tracking, and reverse-order resource disposal.
 *
 * @module
 */

import type { DisposableResource, LifecycleState } from './types'

/** Application shutdown budget shared by Node hosting and programmatic instances. */
export interface ShutdownBudget {
  readonly deadline: number
  readonly reserve: number
}

/** Canonical budget used until a Node host supplies its resolved settings. */
export const DEFAULT_SHUTDOWN_BUDGET: ShutdownBudget = { deadline: 10000, reserve: 2000 }

/** Live shutdown state shared with services; the deadline uses performance.now(). */
export interface ShutdownContext {
  readonly budget: ShutdownBudget
  readonly deadline?: number
}

/** WeakMap binding application instances to their underlying LifecycleManager. */
export const applicationLifecycles = new WeakMap<object, LifecycleManager>()

/** Coordinates application state transitions, in-flight requests, and resource teardown. */
export class LifecycleManager {
  private _state: LifecycleState = 'initializing'
  private readonly resources: DisposableResource[] = []
  private readonly cancellation = new AbortController()
  private readonly drainController = new AbortController()
  private activeRequests = 0
  private idle?: ReturnType<typeof Promise.withResolvers<void>>
  private disposal?: Promise<void>
  private closing?: Promise<void>
  private disposalBarrier: Promise<void> = Promise.resolve()
  private readonly shutdownState: { budget: ShutdownBudget; deadline?: number } = {
    budget: DEFAULT_SHUTDOWN_BUDGET,
  }

  /** Live host settings and the current absolute shutdown deadline. */
  get shutdown(): ShutdownContext {
    return this.shutdownState
  }

  /** Installs the host's already resolved budget before accepting requests. */
  configureShutdown(budget: ShutdownBudget): void {
    this.shutdownState.budget = budget
  }

  /** Current lifecycle phase of the managed application. */
  get state(): LifecycleState {
    return this._state
  }

  /** Abort signal triggered when the lifecycle is forcibly cancelled or timed out. */
  get signal(): AbortSignal {
    return this.cancellation.signal
  }

  /** Abort signal triggered when the application enters the draining phase. */
  get drainingSignal(): AbortSignal {
    return this.drainController.signal
  }

  /** Number of currently active in-flight requests. */
  get pendingRequests(): number {
    return this.activeRequests
  }

  /** Transitions the lifecycle from `initializing` to `ready`. */
  setReady(): void {
    if (this._state === 'initializing') this._state = 'ready'
  }

  /** Transitions the lifecycle to `draining`, rejecting new work and preparing for shutdown. */
  setDraining(): void {
    if (this._state === 'ready' || this._state === 'initializing') {
      this._state = 'draining'
      this.drainController.abort()
    }
  }

  /** Increments the active request counter when a request begins execution. */
  beginRequest(): void {
    this.activeRequests++
  }

  /**
   * Decrements the active request counter when a request finishes.
   * Resolves the idle waiter when active requests reach zero.
   */
  endRequest(): void {
    this.activeRequests--
    if (this.activeRequests === 0) {
      const idle = this.idle
      this.idle = undefined
      idle?.resolve()
    }
  }

  /**
   * Waits until all currently in-flight requests finish processing.
   *
   * @returns Resolves when pending requests drop to zero, or rejects if cancelled.
   */
  waitForIdle(): Promise<void> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason)
    if (this.activeRequests === 0) return Promise.resolve()
    return (this.idle ??= Promise.withResolvers<void>()).promise
  }

  /**
   * Cancels pending idle waiters and aborts the lifecycle cancellation signal.
   *
   * @param reason - Error indicating why the lifecycle was aborted (e.g. shutdown timeout).
   */
  cancel(reason: Error): void {
    if (this.signal.aborted) return
    this.cancellation.abort(reason)
    this.idle?.reject(reason)
    this.idle = undefined
  }

  /**
   * Registers a disposable resource to be cleanly torn down during shutdown.
   *
   * @param resource - Named resource with a `dispose()` method.
   * @throws {Error} If called when the lifecycle is already draining or closed.
   */
  register(resource: DisposableResource): void {
    if (this._state === 'draining' || this._state === 'closed' || this.disposal) {
      throw new Error(`Cannot register resource ${resource.name} on a closing/closed lifecycle`)
    }
    this.resources.push(resource)
  }

  /**
   * Initiates resource disposal without waiting for in-flight requests.
   *
   * @returns Resolves when all registered resources have been disposed.
   * @throws {AggregateError} If any disposer fails; remaining disposers still run.
   */
  disposeAll(): Promise<void> {
    return (this.disposal ??= this.dispose())
  }

  /**
   * Defers normal shutdown disposal until the transport host releases the barrier.
   *
   * The production Node host releases it after draining or expiration of its budget.
   * The development host waits for accepted request operations to settle, including after
   * cancellation, so unfinished work retains its resources even if the handoff times out.
   *
   * @param barrier - Host-owned promise resolving when disposal may proceed.
   * @param deadline - Total host shutdown deadline on the performance.now() clock.
   */
  deferDisposalUntil(barrier: Promise<void>, deadline?: number): void {
    this.disposalBarrier = barrier
    this.shutdownState.deadline = deadline
  }

  /**
   * Performs an orderly graceful shutdown.
   *
   * Transitions to `draining`, waits for active requests to finish, awaits the
   * disposal barrier (if any), and finally tears down all resources in reverse order.
   *
   * @returns Resolves when the application has cleanly closed.
   * @throws If waiting or disposal fails; multiple failures use AggregateError.
   */
  close(): Promise<void> {
    this.setDraining()
    return (this.closing ??= this.finishClose())
  }

  private async finishClose(): Promise<void> {
    const errors: unknown[] = []
    try {
      await this.waitForIdle()
    } catch (error) {
      errors.push(error)
    }
    await this.disposalBarrier
    // A host timeout can reject its wait, but unfinished handlers still own their resources.
    if (this.activeRequests > 0) await (this.idle ??= Promise.withResolvers<void>()).promise
    try {
      await this.disposeAll()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Application close failed')
  }

  private async dispose(): Promise<void> {
    this.setDraining()
    const errors: unknown[] = []
    while (this.resources.length > 0) {
      const resource = this.resources.pop()!
      try {
        await resource.dispose({ signal: this.signal, deadline: this.shutdownState.deadline })
      } catch (error) {
        errors.push(error)
      }
    }
    this._state = 'closed'
    if (errors.length > 0)
      throw new AggregateError(errors, 'One or more resources failed to dispose')
  }
}
