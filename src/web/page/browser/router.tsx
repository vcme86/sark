import { createElement, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { hydrateRoot } from 'react-dom/client'

import { createClient, type HttpClient } from '../../http/client/client'
import { DefaultError, ScopedErrorBoundary } from '../components/error'
import { registerPrefetchCoordinator } from '../components/link'
import { DefaultRoot } from '../components/root'
import { type PageContextValue, PageProvider } from '../context'
import { registerBrowserNavigation } from '../hooks'
import { matchClientRoute } from '../match'
import { type BootstrapData, PageController } from './controller'
import { BrowserHistory } from './history'
import { type ClientRoute, prepareClientRoute } from './route'

export { matchClientRoute, matchPattern } from '../match'
export { type ClientRoute, type ClientScope, prepareClientRoute } from './route'

interface RouterRootProps {
  readonly controller: PageController
  readonly history: BrowserHistory
  readonly client: HttpClient<unknown>
  readonly bootstrapJson: string
}

function ClientRouterRoot({ controller, history, client, bootstrapJson }: RouterRootProps) {
  const { view, navigation } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const outletChain = useMemo(
    () =>
      view.route.scopes.map((scope) => {
        const snapshot = view.scopes[scope.id]
        return createElement(
          ScopedErrorBoundary,
          {
            key: scope.id,
            scopeId: scope.id,
            resetKey:
              view.retryId === undefined || view.retryId === scope.id ? view.revision : undefined,
            errorComponent: scope.errorComponent ?? DefaultError,
            initialError: snapshot?.status === 'error' ? snapshot.error : undefined,
            onRetry: () => void controller.retryScope(scope.id),
            onRedirect: (to: string) => {
              void controller.navigate(to, { replace: true })
            },
          },
          createElement(scope.component!, {
            data: snapshot?.status === 'success' ? snapshot.data : undefined,
            params: view.params,
            url: view.url,
          }),
        )
      }),
    [view, controller],
  )

  useLayoutEffect(() => {
    history.applyPosition()
  }, [history, view.revision])
  useEffect(() => {
    const unlisten = history.listen((url, target) => {
      void controller.navigate(url, {}, target)
    }, controller.hasBlockers)
    const unregister = registerBrowserNavigation(controller.reload, controller.setIdentity)
    return () => {
      unlisten()
      unregister()
      controller.dispose()
    }
  }, [controller, history])
  useEffect(
    () =>
      registerPrefetchCoordinator((to) => {
        void controller.prefetch(to).catch((error) => history.report(error))
      }),
    [controller, history],
  )

  const context: PageContextValue = {
    client,
    url: view.url,
    params: view.params,
    identity: view.identity,
    scopes: view.scopes,
    navigation,
    navigate: controller.navigate,
    reload: controller.reload,
    retryScope: controller.retryScope,
    setIdentity: controller.setIdentity,
    submitAction: controller.submitAction,
    registerBlocker: controller.registerBlocker,
    unregisterBlocker: controller.unregisterBlocker,
    meta: view.meta,
    outletChain,
    bootstrapJson,
  }
  return createElement(
    PageProvider,
    { value: context },
    createElement(view.route.rootComponent ?? DefaultRoot),
  )
}

/**
 * Prepares the server-selected modules before hydrating the complete document.
 * Failures before hydrateRoot are logged and leave the SSR document intact.
 *
 * @param routes - Generated route metadata and Vite dynamic imports.
 * @param fallbackClient - Optional transport supplied by a host embedding the runtime.
 * @returns A promise resolving after hydration starts or a startup failure has been reported.
 */
export async function hydratePageApplication(
  routes: readonly ClientRoute[],
  fallbackClient?: HttpClient<unknown>,
): Promise<void> {
  const json = document.getElementById('__PAGE_CONTEXT__')?.textContent
  if (!json) return
  try {
    const payload = JSON.parse(json) as BootstrapData
    const url = new URL(location.href)
    const match = matchClientRoute(routes, url.pathname, payload.policy.caseSensitive)
    if (!match) throw new Error('The server-selected route is absent from the browser build.')
    await prepareClientRoute(match.route)
    const config = payload.build.api
    const client =
      fallbackClient ??
      createClient({
        baseUrl: new URL(config.browserUrl, location.origin).href,
        credentials: config.credentials,
      })
    const history = new BrowserHistory()
    const controller = new PageController(
      routes,
      client,
      history,
      payload.build.styles,
      { ...payload.request, url: url.href },
      payload.policy,
    )
    hydrateRoot(
      document,
      createElement(ClientRouterRoot, { controller, history, client, bootstrapJson: json }),
    )
  } catch (error) {
    console.error('Page hydration could not start; preserving server HTML.', error)
  }
}
