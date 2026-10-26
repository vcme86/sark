/**
 * Accessible client-side navigation link component.
 *
 * @module
 */

import { type AnchorHTMLAttributes, type MouseEvent, useCallback } from 'react'

import { useOptionalPageContext } from '../context'

let prefetchCoordinator: ((to: string) => void) | undefined

/** Registers the client runtime prefetch callback. */
export function registerPrefetchCoordinator(fn: (to: string) => void): () => void {
  prefetchCoordinator = fn
  return () => {
    if (prefetchCoordinator === fn) prefetchCoordinator = undefined
  }
}

/** Props for the Link component. */
export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** Target destination path. */
  readonly to: string
  /** Whether to replace the current history entry instead of pushing. */
  readonly replace?: boolean
  /** Whether to prevent resetting scroll position to top. */
  readonly preventScrollReset?: boolean
  /** Prefetch policy (defaults to 'module'). */
  readonly prefetch?: 'none' | 'module'
}

function isExternalUrl(url: string): boolean {
  return /^(?:[a-z]+:|\/\/)/i.test(url)
}

/**
 * Renders a native anchor with optional client navigation and module prefetching.
 * Clicks and prefetches use the anchor's resolved URL, honoring the document base.
 * Modified clicks, external URLs, downloads, and non-self targets retain native behavior.
 *
 * @param props - Anchor attributes plus destination, history, scroll, and prefetch options.
 * @returns An anchor that also works without a page provider or hydration.
 */
export function Link({
  to,
  replace,
  preventScrollReset,
  prefetch = 'module',
  onClick,
  onMouseEnter,
  onFocus,
  children,
  target,
  download,
  ...rest
}: LinkProps) {
  const context = useOptionalPageContext()

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (event.defaultPrevented) return

      // Allow native browser behaviors: non-left click, modifier keys, target, download, external
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey ||
        (target && target !== '_self') ||
        event.currentTarget.hasAttribute('download') ||
        isExternalUrl(to) ||
        !context
      ) {
        return
      }

      event.preventDefault()
      context.navigate(event.currentTarget.href, { replace, preventScrollReset })
    },
    [onClick, target, to, context, replace, preventScrollReset],
  )

  const handlePrefetch = useCallback(
    (anchor: HTMLAnchorElement) => {
      if (prefetch === 'none' || isExternalUrl(to)) return
      prefetchCoordinator?.(anchor.href)
    },
    [prefetch, to],
  )

  const handleMouseEnter = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onMouseEnter?.(event)
      handlePrefetch(event.currentTarget)
    },
    [onMouseEnter, handlePrefetch],
  )

  const handleFocus = useCallback(
    (event: React.FocusEvent<HTMLAnchorElement>) => {
      onFocus?.(event)
      handlePrefetch(event.currentTarget)
    },
    [onFocus, handlePrefetch],
  )

  return (
    <a
      href={to}
      target={target}
      download={download}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onFocus={handleFocus}
      {...rest}
    >
      {children}
    </a>
  )
}
