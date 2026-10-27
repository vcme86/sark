import { once } from 'node:events'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { createServer, normalizePath } from 'vite'
import { describe, expect, it, vi } from 'vitest'

import { getCurrentScope } from '../../src/core/context'
import { applicationLifecycles } from '../../src/core/lifecycle'
import { createDefinition } from '../../src/entries/runtime/core'
import { defineApp, route } from '../../src/entries/server'
import { sark } from '../../src/entries/vite'
import { parseApiFilePath } from '../../src/web/http/path'
import { createDevHandoff } from '../helpers/dev-handoff'
import { createProject, serverUrl, viteEntry } from '../helpers/project'

it('serves generated routes, respects prefix boundaries and reloads imported helpers through real Vite', async () => {
  const project = createProject()
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp({ csrf: false })`,
  )
  project.write('helper.ts', "export const message = 'before'\n")
  const routeSource = `import { route } from '@olivaw/sark/server'
import { message } from '../helper'
export default route().handler(() => ({ message }))\n`
  project.write('api/hello.post.ts', routeSource)
  project.write(
    'vite.config.mts',
    `import { sark } from ${JSON.stringify(viteEntry)}
export default { plugins: [sark()] }`,
  )
  const helperFile = normalizePath(join(project.root, 'helper.ts'))
  const watchEntered = Promise.withResolvers<void>()
  const releaseWatch = Promise.withResolvers<void>()
  const graphUpdated = Promise.withResolvers<void>()
  let blockHelper = true
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    server = await createServer({
      root: project.root,
      logLevel: 'silent',
      plugins: [
        {
          name: 'test:async-watch-change',
          async watchChange(id) {
            if (blockHelper && id === helperFile) {
              watchEntered.resolve()
              await releaseWatch.promise
            }
          },
          hotUpdate({ file }) {
            if (this.environment.name === 'ssr' && file === helperFile) graphUpdated.resolve()
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const origin = serverUrl(server.httpServer)
    const send = () => fetch(origin + '/API/hello', { method: 'POST' })
    const first = await send()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ message: 'before' })
    for (const path of ['/assets/missing.js', '/api-docs']) {
      const response = await fetch(serverUrl(server.httpServer) + path)
      expect(response.status).toBe(404)
      expect(response.headers.get('X-Request-Id')).toBeNull()
    }
    project.write('helper.ts', "export const message = 'after'\n")
    await watchEntered.promise
    try {
      const duringUpdate = await send()
      expect(duringUpdate.status).toBe(200)
      await duringUpdate.text()
    } finally {
      blockHelper = false
      releaseWatch.resolve()
    }
    await graphUpdated.promise
    await expect.poll(async () => (await (await send()).json()).message).toBe('after')

    // A failed route module must produce an error, rather than silently serving stale output.
    project.write('api/hello.post.ts', 'export default ; invalid syntax')
    await expect.poll(async () => (await send()).status).toBe(500)
    project.write('api/hello.post.ts', routeSource)
    await expect
      .poll(async () => {
        const response = await send()
        return response.status === 200 ? response.json() : null
      })
      .toEqual({ message: 'after' })

    // Route creation/removal also changes generated imports, not just an existing route module.
    project.write(
      'api/added.get.ts',
      `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ added: true }))`,
    )
    const added = () => fetch(origin + '/api/added')
    await expect
      .poll(async () => {
        const response = await added()
        return response.status === 200 ? response.json() : null
      })
      .toEqual({ added: true })
    unlinkSync(join(project.root, 'api/added.get.ts'))
    await expect.poll(async () => (await added()).status).toBe(404)
  } finally {
    releaseWatch.resolve()
    try {
      await server?.close()
    } finally {
      project.remove()
    }
  }
}, 15000)

function resourceDefinition(dispose: () => Promise<void>) {
  return createDefinition({
    app: defineApp({}),
    routes: [
      {
        routePath: parseApiFilePath('work.get.ts', '/api')!,
        declaration: route().handler(() => {
          const app = getCurrentScope()?.app
          if (!app) throw new Error('Missing application scope')
          applicationLifecycles.get(app)!.register({ name: 'test-resource', dispose })
          return { ready: true }
        }),
      },
    ],
  })
}

describe('development instance handoff coordinator', () => {
  it('waits for resource disposal before loading a replacement instance', async () => {
    const project = createProject()
    project.write('app.ts', 'export const app = {}')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let disposed = false
    const definition = resourceDefinition(async () => {
      entered.resolve()
      await release.promise
      disposed = true
    })
    const load = vi.fn(async () => ({ definition }))
    const harness = await createDevHandoff(project.root, sark(), load)
    let replacement: Promise<Response> | undefined
    try {
      expect((await harness.request('/api/work')).status).toBe(200)
      harness.invalidate(join(project.root, 'app.ts'))
      await entered.promise
      const received = once(harness.httpServer, 'request')
      replacement = harness.request('/api/work')
      await received
      expect(disposed).toBe(false)
      expect(load).toHaveBeenCalledTimes(1)
      release.resolve()
      expect((await replacement).status).toBe(200)
      expect(disposed).toBe(true)
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve()
      await replacement
      await harness.close()
      project.remove()
    }
  })

  it('rejects replacement requests after disposal fails', async () => {
    const project = createProject()
    project.write('app.ts', 'export const app = {}')
    const failed = Promise.withResolvers<void>()
    const definition = resourceDefinition(async () => {
      failed.resolve()
      throw new Error('disposal exploded')
    })
    const load = vi.fn(async () => ({ definition }))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await createDevHandoff(project.root, sark(), load)
    try {
      expect((await harness.request('/api/work')).status).toBe(200)
      harness.invalidate(join(project.root, 'app.ts'))
      await failed.promise
      const response = await harness.request('/api/work')
      expect(response.status).toBe(500)
      expect(await response.text()).toContain('previous instance disposal failed')
      expect(load).toHaveBeenCalledTimes(1)
      expect(errorLog).toHaveBeenCalled()
    } finally {
      await harness.close()
      project.remove()
      errorLog.mockRestore()
    }
  })

  it('awaits resource disposal in closeBundle', async () => {
    const project = createProject()
    project.write('app.ts', 'export const app = {}')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let disposed = false
    const definition = resourceDefinition(async () => {
      entered.resolve()
      await release.promise
      disposed = true
    })
    const harness = await createDevHandoff(project.root, sark(), async () => ({ definition }))
    try {
      expect((await harness.request('/api/work')).status).toBe(200)
      const closing = harness.closeBundle()
      await entered.promise
      expect(disposed).toBe(false)
      release.resolve()
      await closing
      expect(disposed).toBe(true)
    } finally {
      release.resolve()
      await harness.close()
      project.remove()
    }
  })

  it('does not mount the Node request listener for Cloudflare targets', async () => {
    const project = createProject()
    const load = vi.fn(async () => ({ definition: createDefinition({}) }))
    const harness = await createDevHandoff(project.root, sark({ target: 'cloudflare' }), load)
    try {
      expect((await harness.request('/api/work')).status).toBe(404)
      expect(load).not.toHaveBeenCalled()
    } finally {
      await harness.close()
      project.remove()
    }
  })
})
