/**
 * Browser visitor initialization helper.
 *
 * @module
 */

import type { BootstrapData } from '../../page/bootstrap'
import { DEFAULT_VISITOR_PATH } from './defaults'

/** Options passed to the browser ensureVisitor helper. */
export interface EnsureVisitorOptions {
  /** Target endpoint URL; defaults to the configured visitor endpoint or `'/__sark/visitor'`. */
  url?: string
  /** Request credentials mode; defaults to `'same-origin'`. */
  credentials?: RequestCredentials
  /** Cancellation signal for the initialization request. */
  signal?: AbortSignal
}

function resolveDefaultEndpoint(): string {
  if (typeof document !== 'undefined') {
    const el = document.getElementById('__PAGE_CONTEXT__')
    if (el) {
      const parsed = JSON.parse(el.textContent ?? '') as BootstrapData
      if (parsed.build.visitor) return parsed.build.visitor.path
    }
  }
  return DEFAULT_VISITOR_PATH
}

interface InFlightEntry {
  promise: Promise<void>
  refCount: number
  abortController: AbortController
}

const inFlight = new Map<string, InFlightEntry>()

/**
 * Requests visitor initialization through the configured POST endpoint.
 * Cookie persistence depends on the browser's credentials and cookie policies.
 * In-flight calls with the same target URL and credentials mode are coalesced.
 * Individual caller signals are isolated so that cancelling one caller does not abort the shared request.
 *
 * @param options - Target URL, credentials mode, and cancellation signal.
 * @returns Resolves after a successful initialization response (HTTP 204).
 * @throws If startup data is invalid, the caller cancels, the request fails, or the response is not HTTP 204.
 */
export async function ensureVisitor(options: EnsureVisitorOptions = {}): Promise<void> {
  if (options.signal?.aborted) {
    throw options.signal.reason
  }

  const url = options.url ?? resolveDefaultEndpoint()
  const credentials = options.credentials ?? 'same-origin'
  const key = `${url}::${credentials}`

  let entry = inFlight.get(key)
  if (!entry) {
    const controller = new AbortController()
    const promise = (async () => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          credentials,
          signal: controller.signal,
        })
        if (response.status !== 204) {
          throw new Error(
            `ensureVisitor failed with HTTP status ${response.status}: expected 204 No Content`,
          )
        }
      } finally {
        if (inFlight.get(key)?.abortController === controller) inFlight.delete(key)
      }
    })()

    entry = {
      promise,
      refCount: 1,
      abortController: controller,
    }
    inFlight.set(key, entry)
  } else {
    entry.refCount++
  }

  if (options.signal) {
    const activeEntry = entry
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        options.signal?.removeEventListener('abort', onAbort)
        activeEntry.refCount--
        if (activeEntry.refCount <= 0) {
          // A new caller must not join a request whose remaining callers have cancelled.
          if (inFlight.get(key) === activeEntry) inFlight.delete(key)
          activeEntry.abortController.abort(options.signal?.reason)
        }
        reject(options.signal?.reason)
      }
      options.signal?.addEventListener('abort', onAbort)

      activeEntry.promise.then(
        () => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        (err) => {
          options.signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
      )
    })
  }

  return entry.promise
}
