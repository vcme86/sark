import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HistoryTarget } from '../../src/page/browser/controller'
import { BrowserHistory } from '../../src/page/browser/history'

function setup(index = 0) {
  const events = new EventTarget()
  const initialState = { __sark: { index, scroll: [0, 0] } }
  const persisted = new Map<string, string>()
  const nativeHistory = {
    state: initialState,
    scrollRestoration: 'auto',
    replaceState: vi.fn((state: typeof initialState) => {
      nativeHistory.state = state
    }),
  }
  const nativeLocation = { href: 'https://example.test/articles' }
  const scrollTo = vi.fn()
  vi.useFakeTimers()
  vi.stubGlobal('history', nativeHistory)
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => persisted.get(key) ?? null,
    setItem: (key: string, value: string) => persisted.set(key, value),
    removeItem: (key: string) => persisted.delete(key),
  })
  vi.stubGlobal('location', nativeLocation)
  vi.stubGlobal('document', {
    activeElement: null,
    body: { getAttribute: () => null, setAttribute() {}, removeAttribute() {}, focus() {} },
  })
  vi.stubGlobal('HTMLElement', EventTarget)
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
  vi.stubGlobal('scrollX', 0)
  vi.stubGlobal('scrollY', 0)
  vi.stubGlobal('scrollTo', scrollTo)
  const browserHistory = new BrowserHistory()
  const pop = vi.fn()
  const cleanup = browserHistory.listen(pop, () => false)
  browserHistory.applyPosition()

  return { events, nativeHistory, nativeLocation, scrollTo, pop, cleanup, persisted }
}

describe('browser history scroll restoration', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces scroll writes and saves the latest position before reloading', () => {
    const { events, nativeHistory, scrollTo, cleanup, persisted } = setup()
    try {
      nativeHistory.replaceState.mockClear()
      for (let top = 1; top <= 120; top++) {
        vi.stubGlobal('scrollY', top)
        events.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(16)
      }
      expect(nativeHistory.replaceState).toHaveBeenCalledTimes(3)
      expect(persisted.size).toBe(0)
      events.dispatchEvent(new Event('pagehide'))
      expect(nativeHistory.replaceState).toHaveBeenCalledTimes(4)

      new BrowserHistory().applyPosition()
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 120, behavior: 'instant' })
    } finally {
      cleanup()
    }
  })

  it('restores the latest position when Back and Forward precede the queued write', () => {
    const { events, nativeHistory, nativeLocation, pop, cleanup } = setup(1)
    try {
      const current = nativeHistory.state
      vi.stubGlobal('scrollY', 120)
      events.dispatchEvent(new Event('scroll'))

      nativeHistory.state = { __sark: { index: 0, scroll: [0, 0] } }
      nativeLocation.href = 'https://example.test/'
      events.dispatchEvent(Object.assign(new Event('popstate'), { state: nativeHistory.state }))
      expect(pop).toHaveBeenLastCalledWith(nativeLocation.href, { index: 0, scroll: [0, 0] })

      nativeHistory.state = current
      nativeLocation.href = 'https://example.test/articles'
      events.dispatchEvent(Object.assign(new Event('popstate'), { state: nativeHistory.state }))
      expect(pop).toHaveBeenLastCalledWith(
        nativeLocation.href,
        expect.objectContaining({ index: 1, scroll: [0, 120] }),
      )
    } finally {
      cleanup()
    }
  })

  it('restores a forward entry from the previous document after reloading', async () => {
    const { events, nativeHistory, nativeLocation, cleanup } = setup()
    const home = nativeHistory.state
    nativeHistory.state = { __sark: { ...home.__sark, index: 1 } }
    const article = new BrowserHistory()
    cleanup()
    const popFromArticle = vi.fn<(url: string, target: HistoryTarget) => void>()
    const stopArticle = article.listen(popFromArticle, () => false)
    article.applyPosition()
    const savedArticle = nativeHistory.state
    try {
      vi.stubGlobal('scrollY', 120)
      events.dispatchEvent(new Event('scroll'))
      nativeHistory.state = home
      nativeLocation.href = 'https://example.test/'
      events.dispatchEvent(Object.assign(new Event('popstate'), { state: home }))
      await article.commit(
        new URL(nativeLocation.href),
        {},
        popFromArticle.mock.lastCall![1],
        () => true,
      )
      article.applyPosition()
      vi.stubGlobal('scrollY', 0)
      events.dispatchEvent(new Event('pagehide'))
    } finally {
      stopArticle()
    }

    const pop = vi.fn()
    const stopHome = new BrowserHistory().listen(pop, () => false)
    try {
      nativeHistory.state = savedArticle
      nativeLocation.href = 'https://example.test/articles'
      events.dispatchEvent(Object.assign(new Event('popstate'), { state: savedArticle }))
      expect(pop).toHaveBeenLastCalledWith(
        nativeLocation.href,
        expect.objectContaining({ index: 1, scroll: [0, 120] }),
      )
    } finally {
      stopHome()
    }
  })
})
