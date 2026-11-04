import { createApp } from '@olivaw/sark'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

import { sark } from '../../src/tooling/vite'
import { createProject } from '../helpers/project'

it.each(['/service/v2/', '/'])(
  'runs generated routes with custom project paths and prefix %s',
  async (apiPrefix) => {
    const project = createProject()
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    let instance: Awaited<ReturnType<typeof createApp>> | undefined
    try {
      project.write(
        'config/application.ts',
        `import { defineApp } from '@olivaw/sark'
export const app = defineApp({ headers: { 'X-Project': 'custom' } })`,
      )
      project.write(
        'handlers/item.get.ts',
        `import { route } from '@olivaw/sark'
export default route().handler(() => ({ item: 42 }))`,
      )
      server = await createServer({
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        server: { middlewareMode: true, hmr: false, watch: null },
        plugins: [
          sark({
            appEntry: 'config/application.ts',
            apiDir: 'handlers',
            apiPrefix,
          }),
        ],
      })
      const { definition } = await server.ssrLoadModule('/.build/app.ts')
      instance = await createApp(definition, { env: process.env })
      const prefix = apiPrefix === '/' ? '' : '/service/v2'
      const response = await instance.fetch(new Request(`https://example.test${prefix}/item`))
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Project')).toBe('custom')
      expect(await response.json()).toEqual({ item: 42 })
      expect((await instance.fetch(new Request('https://example.test/api/item'))).status).toBe(404)
    } finally {
      await instance?.close()
      await server?.close()
      project.remove()
    }
  },
)
