import type { NavigateOptions } from '../types'
import type { HistoryTarget, NavigationHost } from './controller'

const STATE_KEY = '__sark'

interface SavedEntry extends HistoryTarget {
  readonly userState?: unknown
}

type PendingPosition =
  | { target: HistoryTarget }
  | { target?: HistoryTarget; url: URL; preventReset?: boolean }

function entry(state: unknown): SavedEntry | undefined {
  if (!state || typeof state !== 'object' || !(STATE_KEY in state)) return undefined
  return (state as Record<string, SavedEntry>)[STATE_KEY]
}

/**
 * Tracks actual history indices. A cancelled traversal goes back by its signed
 * delta rather than adding an entry or assuming the user always pressed Back.
 */
export class BrowserHistory implements NavigationHost {
  private current: SavedEntry
  private physicalIndex: number
  private restoring?: { index: number; done: () => void; promise: Promise<void> }
  private pendingPosition?: PendingPosition
  private saveFrame?: number

  constructor() {
    const saved = entry(history.state)
    this.current = saved ?? { index: 0, scroll: [scrollX, scrollY] }
    this.physicalIndex = this.current.index
    if (saved) this.pendingPosition = { target: saved }
  }

  private write(value: SavedEntry): void {
    const state = history.state
    history.replaceState(
      { ...(state && typeof state === 'object' ? state : {}), [STATE_KEY]: value },
      '',
    )
  }

  private save = (): void => {
    if (this.physicalIndex !== this.current.index || this.restoring || this.pendingPosition) return
    this.current = {
      ...this.current,
      scroll: [scrollX, scrollY],
      focus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement.id || undefined
          : undefined,
    }
    this.write(this.current)
  }

  private onScroll = (): void => {
    if (this.saveFrame !== undefined) return
    this.saveFrame = requestAnimationFrame(() => {
      this.saveFrame = undefined
      this.save()
    })
  }

  /**
   * Subscribes to native traversal and records scroll/focus for history restoration.
   *
   * @param pop - Receives a browser-selected history entry requiring client navigation.
   * @param blocked - Reports whether any leave guard requires a native document-exit prompt.
   * @returns Cleanup removing listeners and restoring the browser's previous scroll policy.
   */
  listen(pop: (url: string, target: HistoryTarget) => void, blocked: () => boolean): () => void {
    const previousRestoration = history.scrollRestoration
    this.write(this.current)
    history.scrollRestoration = 'manual'
    const onPop = (event: PopStateEvent) => {
      const target = entry(event.state)
      if (!target) {
        location.reload()
        return
      }
      this.physicalIndex = target.index
      if (this.restoring?.index === target.index) {
        const restore = this.restoring
        this.restoring = undefined
        restore.done()
        return
      }
      pop(location.href, target)
    }
    const onUnload = (event: BeforeUnloadEvent) => {
      if (blocked()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    addEventListener('popstate', onPop)
    addEventListener('scroll', this.onScroll, { passive: true })
    addEventListener('focusin', this.save)
    addEventListener('pagehide', this.save)
    addEventListener('beforeunload', onUnload)
    return () => {
      removeEventListener('popstate', onPop)
      removeEventListener('scroll', this.onScroll)
      removeEventListener('focusin', this.save)
      removeEventListener('pagehide', this.save)
      removeEventListener('beforeunload', onUnload)
      if (this.saveFrame !== undefined) cancelAnimationFrame(this.saveFrame)
      this.saveFrame = undefined
      this.restoring?.done()
      this.restoring = undefined
      history.scrollRestoration = previousRestoration
    }
  }

  /**
   * Undoes a native traversal using its signed delta and waits for the compensating popstate.
   *
   * @param target - Native entry being rejected; the destination is the last committed view.
   * @returns A promise resolving after restoration, or immediately if no restoration is needed.
   */
  async restore(target: HistoryTarget): Promise<void> {
    if (this.restoring) return this.restoring.promise
    if (this.physicalIndex !== target.index || this.physicalIndex === this.current.index) return
    let done!: () => void
    const promise = new Promise<void>((resolve) => {
      done = resolve
    })
    this.restoring = { index: this.current.index, done, promise }
    history.go(this.current.index - this.physicalIndex)
    await promise
  }

  /**
   * Commits history after any outstanding traversal restoration, then schedules position recovery.
   *
   * @param url - Final destination after matching and loader redirects.
   * @param options - Replacement, caller state, and scroll-reset choices for new navigation.
   * @param target - Existing entry for native Back/Forward, absent for new navigation.
   * @param owns - Rechecked after waiting so stale operations cannot mutate browser history.
   * @returns A promise resolving once history is committed or the operation has lost ownership.
   */
  async commit(
    url: URL,
    options: NavigateOptions,
    target: HistoryTarget | undefined,
    owns: () => boolean,
  ): Promise<void> {
    if (this.restoring) await this.restoring.promise
    if (!target && this.physicalIndex !== this.current.index) {
      await this.restore({ index: this.physicalIndex, scroll: [0, 0] })
    }
    if (!owns()) return
    if (target) {
      this.current = target
      // Loader redirects during popstate replace the selected entry, not the old view.
      if (url.href !== location.href) history.replaceState(history.state, '', url)
    } else {
      this.save()
      this.current = {
        index: this.current.index + (options.replace ? 0 : 1),
        scroll: [0, 0],
        userState: options.state,
      }
      const state = {
        ...(options.state && typeof options.state === 'object' ? options.state : {}),
        [STATE_KEY]: this.current,
      }
      if (options.replace) history.replaceState(state, '', url)
      else history.pushState(state, '', url)
    }
    this.physicalIndex = this.current.index
    this.pendingPosition = { target, url, preventReset: options.preventScrollReset }
  }

  /** Applies scroll and focus only after React has committed the new document contents. */
  applyPosition(): void {
    const pending = this.pendingPosition
    if (!pending) return
    this.pendingPosition = undefined
    if (!('url' in pending)) {
      const [left, top] = pending.target.scroll
      scrollTo({ left, top, behavior: 'instant' })
      return
    }
    const focus = pending.target?.focus && document.getElementById(pending.target.focus)
    if (focus) focus.focus({ preventScroll: true })
    else {
      const body = document.body
      const previous = body.getAttribute('tabindex')
      body.setAttribute('tabindex', '-1')
      body.focus({ preventScroll: true })
      if (previous === null) body.removeAttribute('tabindex')
      else body.setAttribute('tabindex', previous)
    }
    if (pending.target) scrollTo(...pending.target.scroll)
    else if (!pending.preventReset) {
      let fragment = pending.url.hash.slice(1)
      try {
        fragment = decodeURIComponent(fragment)
      } catch {
        /* A fragment may contain a literal percent sign. */
      }
      const anchor = fragment && document.getElementById(fragment)
      if (anchor) anchor.scrollIntoView()
      else scrollTo(0, 0)
    }
  }

  hardNavigate(url: URL): void {
    location.assign(url.href)
  }
  report(error: unknown): void {
    console.error('Page navigation failed', error)
  }
}
