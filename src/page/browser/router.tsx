import { createElement, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { hydrateRoot } from 'react-dom/client'

import { createClient, type HttpClient } from '../../client/client'
import { DEFAULT_URL_POLICY } from '../../http/url'
import type { BootstrapData } from '../bootstrap'
import { DefaultError, ScopedErrorBoundary } from '../components/error'
import { registerPrefetchCoordinator } from '../components/link'
import { DefaultRoot } from '../components/root'
import { type PageContextValue, PageProvider } from '../context'
import { registerBrowserNavigation } from '../hooks'
import { matchClientRoute } from '../match'
import { PageController } from './controller'
import { BrowserHistory } from './history'
import { type ClientRoute, prepareClientRoute } from './route'

interface RouterRootProps {
  readonly controller: PageController
  readonly history: BrowserHistory
  readonly client: HttpClient<unknown>
  readonly bootstrapJson: string
  readonly stylesheets: readonly string[]
  readonly dispose: () => void
}

function ClientRouterRoot({
  controller,
  history,
  client,
  bootstrapJson,
  stylesheets,
  dispose,
}: RouterRootProps) {
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
              view.resetScopes === undefined || view.resetScopes.has(scope.id)
                ? view.revision
                : undefined,
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
  useEffect(() => dispose, [dispose])
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
    meta: view.meta,
    stylesheets,
    outletChain,
    bootstrapJson,
    navigate: controller.navigate,
    reload: controller.reload,
    retryScope: controller.retryScope,
    setIdentity: controller.setIdentity,
    submitAction: controller.submitAction,
    registerBlocker: controller.registerBlocker,
    unregisterBlocker: controller.unregisterBlocker,
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
 * @param apiPrefix - Default API base from the generated browser entry.
 * @returns A promise resolving after hydration starts or a startup failure has been reported.
 */
export async function hydratePageApplication(
  routes: readonly ClientRoute[],
  apiPrefix: string,
): Promise<void> {
  const json = document.getElementById('__PAGE_CONTEXT__')?.textContent
  if (!json) {
    console.error(
      'Page hydration could not start: bootstrap data is missing; preserving server HTML.',
    )
    return
  }
  let dispose: (() => void) | undefined
  try {
    const payload = JSON.parse(json) as BootstrapData
    const url = new URL(location.href)
    const policy = { ...DEFAULT_URL_POLICY, ...payload.config?.policy }
    const match = matchClientRoute(routes, url.pathname, policy.caseSensitive)
    if (!match) throw new Error('The server-selected route is absent from the browser build.')
    const stylesheets = Array.from(
      document.head.querySelectorAll<HTMLLinkElement>('link[data-page-style][href]'),
      (link) => link.getAttribute('href')!,
    )
    await prepareClientRoute(match.route)
    const client = createClient({
      baseUrl: new URL(payload.config?.api?.browserUrl ?? apiPrefix, url.origin).href,
      credentials: payload.config?.api?.credentials,
    })
    const history = new BrowserHistory()
    const controller = new PageController(
      routes,
      client,
      history,
      {
        ...match,
        url,
        scopes: payload.request.scopes,
        identity: payload.request.identity ?? { user: null },
      },
      policy,
    )
    const unlisten = history.listen((destination, target) => {
      void controller.navigate(destination, {}, target)
    }, controller.hasBlockers)
    const unregister = registerBrowserNavigation(controller.reload, controller.setIdentity)
    let disposed = false
    dispose = () => {
      if (disposed) return
      disposed = true
      unlisten()
      unregister()
      controller.dispose()
    }
    hydrateRoot(
      document,
      createElement(ClientRouterRoot, {
        controller,
        history,
        client,
        bootstrapJson: json,
        stylesheets,
        dispose,
      }),
      {
        onUncaughtError(error) {
          dispose?.()
          console.error('Page hydration failed.', error)
        },
      },
    )
  } catch (error) {
    dispose?.()
    console.error('Page hydration could not start; preserving server HTML.', error)
  }
}
