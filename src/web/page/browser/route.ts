import type { ComponentType, ReactNode } from 'react'

import type { PageError, RuntimePageModule } from '../types'

/** Registered client-side route specification for navigation matching. */
export interface ClientRoute {
  /** Route path pattern (e.g. `/posts/:id`). */
  readonly pattern: string
  /** Canonical path shape identifying routes independently of parameter names. */
  readonly shapeKey: string
  /** Parameter names extracted from pattern. */
  readonly paramNames: readonly string[]
  /** Root document component. */
  rootComponent?: ComponentType<{ children?: ReactNode }>
  /** Dynamic loader for root document module. */
  readonly rootLoad?: () => Promise<{ default: ComponentType<{ children?: ReactNode }> }>
  /** Ordered scopes from root layout to leaf page component. */
  readonly scopes: readonly ClientScope[]
}

/** Client scope metadata. */
export interface ClientScope {
  /** Scope identifier. */
  readonly id: string
  /** Dynamic module loader for code-splitting. */
  readonly load?: () => Promise<RuntimePageModule>
  /** Component function (layout or page). */
  component?: RuntimePageModule['default']
  /** Dynamic loader for error component module. */
  readonly errorLoad?: () => Promise<{
    default: ComponentType<{ error: PageError; retry(): void }>
  }>
  /** Optional error presentation component. */
  errorComponent?: ComponentType<{ error: PageError; retry(): void }>
  /** Optional client loader function. */
  loader?: RuntimePageModule['loader']
  /** Optional meta descriptor generator. */
  meta?: RuntimePageModule['meta']
  /** Custom revalidation decider. */
  shouldRevalidate?: RuntimePageModule['shouldRevalidate']
}

const imports = new WeakMap<() => Promise<unknown>, Promise<unknown>>()

function load<T>(loader: () => Promise<T>): Promise<T> {
  let pending = imports.get(loader)
  if (!pending) {
    pending = loader().catch((error) => {
      imports.delete(loader)
      throw error
    })
    imports.set(loader, pending)
  }
  return pending as Promise<T>
}

/**
 * Loads a route's root, layout, page, and error modules before rendering.
 * Vite's dynamic imports also load their associated CSS. Concurrent calls share imports;
 * failed imports are removed so a later attempt can retry.
 *
 * @param route - Matched route whose module fields are populated in place.
 * @returns A promise resolving once all required imports and their CSS are ready.
 * @throws {Error} If any required module or associated resource fails to load.
 */
export async function prepareClientRoute(route: ClientRoute): Promise<void> {
  await Promise.all([
    route.rootLoad && !route.rootComponent
      ? load(route.rootLoad).then((module) => {
          route.rootComponent = module.default
        })
      : undefined,
    ...route.scopes.flatMap((scope) => [
      scope.load && !scope.component
        ? load(scope.load).then((module) => {
            scope.component = module.default
            scope.loader = module.loader
            scope.meta = module.meta
            scope.shouldRevalidate = module.shouldRevalidate
          })
        : undefined,
      scope.errorLoad && !scope.errorComponent
        ? load(scope.errorLoad).then((module) => {
            scope.errorComponent = module.default
          })
        : undefined,
    ]),
  ])
}
