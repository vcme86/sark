import { createDefinition } from '../../src/entries/runtime/core'
import {
  type AppConfig,
  createApp,
  defineApp,
  route,
  type RouteDeclaration,
  type RouteHandler,
} from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteEntry } from '../../src/http/server/types'
import type { SseDeclaration } from '../../src/http/types'

/** Builds a route fixture from a mounted path or route filename. */
export function routeEntry(
  path: string,
  handler: RouteHandler | RouteDeclaration | SseDeclaration,
  method = 'get',
) {
  const file = path.endsWith('.ts')
    ? path
    : path.replace(/^\/api\//, '').replace(/:([a-zA-Z0-9_]+)/g, '[$1]') +
      `.${method.toLowerCase()}.ts`
  const declaration = typeof handler === 'function' ? route().handler(handler) : handler
  return { routePath: parseApiFilePath(file, '/api')!, declaration }
}

/** Dispatches one in-memory request and closes its application. */
export async function executeRequest(config: AppConfig, entry: RouteEntry, request: Request) {
  const app = await createApp(createDefinition({ app: defineApp(config), routes: [entry] }))
  try {
    return await app.fetch(request)
  } finally {
    await app.close()
  }
}
