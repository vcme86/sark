import type { NavigateOptions } from '../types'
import type { HistoryTarget, NavigationHost } from './controller'

const STATE_KEY = '__sark'
const POSITION_SAVE_INTERVAL = 500

interface SavedEntry extends HistoryTarget {
  readonly positionKey?: string
  readonly userState?: unknown
}

type SavedPosition = Pick<HistoryTarget, 'scroll' | 'focus'>

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
  private saveTimer?: ReturnType<typeof setTimeout>
  private readonly positionKey: string
  private readonly pendingPositions: Map<number, SavedPosition>

  constructor() {
    const saved = entry(history.state)
    this.positionKey =
      saved?.positionKey ??
      `${STATE_KEY}:positions:${crypto.getRandomValues(new Uint32Array(4)).join('-')}`
    this.pendingPositions = saved?.positionKey ? this.readPendingPositions() : new Map()
    this.current = saved
      ? this.withPendingPosition(saved)
      : { index: 0, scroll: [scrollX, scrollY] }
    this.physicalIndex = this.current.index
    if (saved) this.pendingPosition = { target: this.current }
  }

  private readPendingPositions(): Map<number, SavedPosition> {
    try {
      const stored = sessionStorage.getItem(this.positionKey)
      if (stored) return new Map(JSON.parse(stored))
    } catch {
      // Storage can be disabled; the active history entry still carries its saved position.
    }
    return new Map()
  }

  private withPendingPosition(saved: SavedEntry): SavedEntry {
    const position = this.pendingPositions.get(saved.index)
    return position ? { ...saved, scroll: position.scroll, focus: position.focus } : saved
  }

  private write(value: SavedEntry, url?: URL): void {
    const state = history.state
    history.replaceState(
      {
        ...(state && typeof state === 'object' ? state : {}),
        [STATE_KEY]: { ...value, positionKey: this.positionKey },
      },
      '',
      url,
    )
    this.pendingPositions.delete(value.index)
  }

  private trackPosition(): boolean {
    if (this.physicalIndex !== this.current.index || this.restoring || this.pendingPosition) {
      return false
    }
    const focus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.id || undefined
        : undefined
    const [left, top] = this.current.scroll
    if (left !== scrollX || top !== scrollY || this.current.focus !== focus) {
      const position: SavedPosition = { scroll: [scrollX, scrollY], focus }
      this.current = { ...this.current, ...position }
      this.pendingPositions.set(this.current.index, position)
    }
    return this.pendingPositions.has(this.current.index)
  }

  private cancelSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
  }

  private save = (): void => {
    this.cancelSave()
    if (this.trackPosition()) this.write(this.current)
  }

  private queueSave = (): void => {
    if (this.trackPosition() && this.saveTimer === undefined) {
      this.saveTimer = setTimeout(this.save, POSITION_SAVE_INTERVAL)
    }
  }

  private saveOnPageHide = (): void => {
    this.save()
    // replaceState can only write the active entry. Persist positions left behind by Back/Forward.
    try {
      if (this.pendingPositions.size) {
        sessionStorage.setItem(this.positionKey, JSON.stringify([...this.pendingPositions]))
      } else sessionStorage.removeItem(this.positionKey)
    } catch {
      // The browser may deny storage access or refuse additional data.
    }
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
      this.cancelSave()
      const saved = entry(event.state)
      if (!saved || (saved.positionKey && saved.positionKey !== this.positionKey)) {
        location.reload()
        return
      }
      const target = this.withPendingPosition(saved)
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
    addEventListener('scroll', this.queueSave, { passive: true })
    addEventListener('focusin', this.queueSave)
    addEventListener('pagehide', this.saveOnPageHide)
    addEventListener('beforeunload', onUnload)
    return () => {
      removeEventListener('popstate', onPop)
      removeEventListener('scroll', this.queueSave)
      removeEventListener('focusin', this.queueSave)
      removeEventListener('pagehide', this.saveOnPageHide)
      removeEventListener('beforeunload', onUnload)
      this.cancelSave()
      this.pendingPositions.clear()
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
      if (url.href !== location.href) this.write(this.current, url)
    } else {
      this.save()
      this.current = {
        index: this.current.index + (options.replace ? 0 : 1),
        scroll: [0, 0],
        userState: options.state,
      }
      const state = {
        ...(options.state && typeof options.state === 'object' ? options.state : {}),
        [STATE_KEY]: { ...this.current, positionKey: this.positionKey },
      }
      if (options.replace) {
        history.replaceState(state, '', url)
        this.pendingPositions.delete(this.current.index)
      } else {
        history.pushState(state, '', url)
        for (const index of this.pendingPositions.keys()) {
          if (index >= this.current.index) this.pendingPositions.delete(index)
        }
      }
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
