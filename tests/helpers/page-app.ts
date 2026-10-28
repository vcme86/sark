import { assembleApp } from '../../src/core/create'
import { type ApplicationDefinitionInput, createDefinition } from '../../src/core/definition'
import { resolveHttpConfig } from '../../src/http/config'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteEntry } from '../../src/http/server/types'
import { createPageConfigResolver } from '../../src/page/config'
import { createPageHandler } from '../../src/page/server/handler'
import type { PageDeclaration, ServerPageScope } from '../../src/page/types'

/**
 * Exercises real page HTTP and React handlers with production policy.
 * File discovery is tested separately; this fixture closes the app after the callback.
 */
export async function withPage(
  page: Omit<ServerPageScope, 'id'>,
  run: (fetch: (request: Request) => Promise<Response>) => Promise<void>,
  options: {
    page?: PageDeclaration
    layouts?: readonly ServerPageScope[]
    routes?: RouteEntry[]
    services?: ApplicationDefinitionInput['services']
  } = {},
) {
  const definition = createDefinition({
    apiPrefix: '/api',
    webPrefix: '/',
    services: options.services,
    createPageConfigResolver: () => createPageConfigResolver(options.page, '/api'),
    routes: [
      ...(options.routes ?? []),
      {
        kind: 'page',
        routePath: parseApiFilePath('index.get.ts', '/')!,
        pageHandler: createPageHandler(
          {
            pattern: '/',
            shapeKey: '/',
            paramNames: [],
            httpScopes: [],
            scopes: [...(options.layouts ?? []), { id: 'page:', ...page }],
          },
          () => ({ bootstrapModules: [], stylesheets: [], routeStyles: {} }),
        ),
      },
    ],
  })
  const app = await assembleApp(definition, {
    kind: 'static',
    config: resolveHttpConfig({}, true),
    env: {},
  })
  try {
    await run((request) => app.fetch(request))
  } finally {
    await app.close()
  }
}
