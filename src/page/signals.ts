/**
 * Isomorphic page signals and control-flow exceptions.
 *
 * @module
 */

/** Resolves relative and HTTP(S) destinations for page navigation. */
export function resolvePageUrl(to: string, base: URL | string): URL {
  const url = new URL(to, base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Page navigation requires an HTTP(S) URL or relative address.')
  }
  return url
}

/** Page redirect signal interpreted by the active HTTP or browser boundary. */
export class RedirectSignal extends Error {
  readonly status: number
  readonly url: string

  constructor(url: string, status = 302) {
    super(`Redirect to ${url}`)
    resolvePageUrl(url, 'https://page.invalid/')
    this.name = 'RedirectSignal'
    this.url = url
    this.status = status
  }
}

/** Thrown by page loaders or actions to trigger a 404 Not Found response or boundary. */
export class NotFoundSignal extends Error {
  readonly status: number = 404

  constructor(message = 'Not Found') {
    super(message)
    this.name = 'NotFoundSignal'
  }
}

/**
 * Throws a redirect signal for the owning loader, action, or rendering boundary.
 * Browser navigation uses replace; SSR can set the HTTP redirect only before headers commit.
 *
 * @param url - Destination path or URL.
 * @param status - HTTP status code (defaults to 302).
 * @throws {RedirectSignal} Always, carrying the destination and status.
 */
export function redirect(url: string, status = 302): never {
  throw new RedirectSignal(url, status)
}

/**
 * Throws a not-found signal for the owning page error boundary.
 *
 * @param message - Optional error message.
 * @throws {NotFoundSignal} Always, carrying HTTP status 404.
 */
export function notFound(message = 'Not Found'): never {
  throw new NotFoundSignal(message)
}
