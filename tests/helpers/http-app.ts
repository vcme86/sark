import type { RouteEntry } from '../../src/app/http/assembly'
import type { SseDeclaration } from '../../src/app/http/types'
import {
  type AppConfig,
  createApp,
  defineApp,
  route,
  type RouteDeclaration,
  type RouteHandler,
} from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { parseApiFilePath } from '../../src/http/path'

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
