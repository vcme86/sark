/**
 * Isomorphic React hooks for HTTP client access, action submission, and navigation.
 *
 * @module
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import type { DefaultApi, HttpClient } from '../http/client/client'
import { useOptionalPageContext, usePageContext } from './context'
import type {
  ActionArgs,
  ActionResult,
  BlockerHandler,
  IdentitySnapshot,
  NavigateOptions,
  NavigationState,
  PageError,
} from './types'

let browserReload: (() => Promise<void>) | undefined
let browserSetIdentity: ((snapshot: IdentitySnapshot) => void) | undefined

/**
 * Connects browser helpers to the hydrated application's navigation controller.
 *
 * @param reloadFn - Reload operation owned by the active browser controller.
 * @param setIdentityFn - Callback updating that controller's display identity.
 * @returns Cleanup that clears these callbacks if they are still registered.
 */
export function registerBrowserNavigation(
  reloadFn: () => Promise<void>,
  setIdentityFn: (snapshot: IdentitySnapshot) => void,
): () => void {
  browserReload = reloadFn
  browserSetIdentity = setIdentityFn
  return () => {
    if (browserReload === reloadFn) browserReload = undefined
    if (browserSetIdentity === setIdentityFn) browserSetIdentity = undefined
  }
}

/**
 * Accesses the HTTP client bound to the current page context.
 *
 * @returns Client instance dispatching internally during SSR or over network in browser.
 * @throws {Error} If called outside a page provider.
 */
export function useClient<Api = DefaultApi>(): HttpClient<Api> {
  return usePageContext().client as HttpClient<Api>
}

/**
 * Creates action submission state for the current page.
 * A new submission or unmount signals cancellation of the previous submission. Successful writes
 * retain their result even if the following loader revalidation fails.
 *
 * @param actionHandler - Function receiving ActionArgs and returning a result.
 * @returns Action data, separate action/revalidation errors, pending state, and submit.
 */
export function useAction<T, Params = Record<string, string | string[]>>(
  actionHandler: (args: ActionArgs<Params>) => T | Promise<T>,
): ActionResult<T> {
  const context = usePageContext()
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<PageError | undefined>(undefined)
  const [revalidateError, setRevalidateError] = useState<PageError | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  const submit = useCallback(
    (formData: FormData) => {
      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller
      setPending(true)
      setError(undefined)
      setRevalidateError(undefined)
      if (!context.submitAction) throw new Error('Actions require a hydrated page application.')
      void context
        .submitAction(
          actionHandler,
          formData,
          (result) => {
            if (!controller.signal.aborted) setData(result)
          },
          controller.signal,
        )
        .then((outcome) => {
          if (controller.signal.aborted) return
          setError(outcome.error)
          setRevalidateError(outcome.revalidateError)
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false)
        })
    },
    [actionHandler, context.submitAction],
  )

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
    }
  }, [])

  return {
    data,
    error,
    revalidateError,
    pending,
    submit,
  }
}

/**
 * Accesses the client navigation trigger function.
 *
 * @returns A navigate function resolving to whether its destination became the committed view.
 * @throws {Error} If called outside a page provider.
 */
export function useNavigate(): (
  to: string,
  options?: NavigateOptions,
) => Promise<{ committed: boolean }> {
  return usePageContext().navigate
}

/** Returns current navigation state (`idle`, `loading`, or `submitting`). */
export function useNavigation(): NavigationState {
  return usePageContext().navigation
}

/**
 * Registers a navigation blocker function that can prevent or confirm leaving the current page.
 *
 * @param handler - Receives current/next URLs and cancellation; false cancels, true/void allows.
 *   Async results are awaited. Native document exits use the browser's confirmation prompt.
 * @param enabled - Whether the blocker is active (defaults to true).
 */
export function useBlocker(handler: BlockerHandler, enabled = true): void {
  const context = useOptionalPageContext()
  const id = useId()
  const handlerRef = useRef(handler)
  useLayoutEffect(() => {
    handlerRef.current = handler
  }, [handler])

  const register = context?.registerBlocker
  const unregister = context?.unregisterBlocker
  useEffect(() => {
    if (!register || !enabled) return
    const stableHandler: BlockerHandler = (args) => handlerRef.current(args)
    register(id, stableHandler)
    return () => {
      unregister?.(id)
    }
  }, [register, unregister, enabled, id])
}

/**
 * Reruns the current route's loaders, bypassing shouldRevalidate.
 * Does nothing when no hydrated browser controller is registered.
 *
 * @returns A promise resolving when the reload settles; scoped failures remain in page state.
 */
export async function reload(): Promise<void> {
  if (browserReload) {
    await browserReload()
  }
}

/**
 * Updates the user identity snapshot in the browser.
 *
 * Invalidates in-flight navigations for the old identity and provides the new snapshot
 * to subsequent loaders. Does not authenticate the user or reload existing data;
 * does nothing without a registered browser controller.
 *
 * @param snapshot - Updated identity snapshot.
 */
export function setIdentity(snapshot: IdentitySnapshot): void {
  if (browserSetIdentity) {
    browserSetIdentity(snapshot)
  }
}
