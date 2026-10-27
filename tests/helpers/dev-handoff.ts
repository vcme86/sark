import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'

import { type Connect, type Plugin, resolveConfig, type ViteDevServer } from 'vite'

import type { NodeRuntimeDeclaration } from '../../src/adapter/node/runtime'
import type { ApplicationDefinition } from '../../src/core/definition'
import { serverUrl } from './project'

/**
 * Exercises the Sark handoff coordinator with real HTTP requests.
 * Only Vite's module loader and update hooks are controlled; module-graph reloads
 * are covered separately by the real Vite integration tests.
 */
export async function createDevHandoff(
  root: string,
  plugin: Plugin,
  load: () => Promise<{ definition: ApplicationDefinition; runtime?: NodeRuntimeDeclaration }>,
) {
  const config = await resolveConfig(
    { root, configFile: false, logLevel: 'silent', plugins: [plugin] },
    'serve',
  )
  const handlers: Connect.NextHandleFunction[] = []
  const httpServer = createServer((req, res) => {
    let index = 0
    function next(error?: unknown) {
      if (error) {
        res.writeHead(500).end(String(error))
      } else {
        const handler = handlers[index++]
        if (handler) handler(req, res, next)
        else res.writeHead(404).end('Outside Sark API')
      }
    }
    next()
  })
  // The coordinator uses only these Vite facilities; HTTP transport is not mocked.
  const server = {
    config,
    watcher: new EventEmitter(),
    middlewares: { use: (handler: Connect.NextHandleFunction) => handlers.push(handler) },
    httpServer,
    ssrLoadModule: load,
    environments: { ssr: { moduleGraph: { onFileChange() {}, getModulesByFile() {} } } },
  } as unknown as ViteDevServer
  if (typeof plugin.configureServer !== 'function') throw new Error('Missing configureServer hook')
  await Reflect.apply(plugin.configureServer, {}, [server])
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const closeBundle = async () => {
    if (typeof plugin.closeBundle !== 'function') throw new Error('Missing closeBundle hook')
    await Reflect.apply(plugin.closeBundle, {}, [])
  }
  return {
    httpServer,
    use(handler: Connect.NextHandleFunction) {
      handlers.push(handler)
    },
    request(path: string, options?: RequestInit) {
      return fetch(serverUrl(httpServer) + path, options)
    },
    invalidate(path: string) {
      if (typeof plugin.hotUpdate !== 'function') throw new Error('Missing hotUpdate hook')
      return Reflect.apply(plugin.hotUpdate, { environment: { name: 'ssr' } }, [
        {
          type: 'update',
          file: path,
          modules: [],
        },
      ])
    },
    closeBundle,
    async close() {
      try {
        await closeBundle()
      } finally {
        httpServer.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  }
}
