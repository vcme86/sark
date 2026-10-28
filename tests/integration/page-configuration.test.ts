import { describe, expect, it } from 'vitest'

import { createWorkerHandler } from '../../src/entries/runtime/cloudflare'
import { createApp } from '../../src/entries/server'
import { generateProject } from '../../src/tooling/build/project'
import { createProject } from '../helpers/project'

function pageProject(target: 'node' | 'cloudflare') {
  const project = createProject()
  project.write(
    'app.ts',
    `import { definePage } from '@olivaw/sark/page'
let calls = 0
export const page = definePage((env: { name: string }) => {
  if (!env?.name) throw new Error('name is required')
  const version = ++calls
  return { identity: () => ({ user: { sub: env.name + '-' + version } }) }
})`,
  )
  project.write(
    'api/ping.get.ts',
    `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ ok: true }))`,
  )
  project.write(
    'app/index.tsx',
    `import type { LoaderArgs } from '@olivaw/sark/page'
export async function loader({ client }: LoaderArgs) {
  await client.get('/ping')
}
export default function Page() { return <h1>Home</h1> }`,
  )
  generateProject(project.root, { target })
  return project
}

describe('Page configuration ownership', () => {
  it('resolves once at creation for each Node instance, even with the same Env object', async () => {
    const project = pageProject('node')
    try {
      const { definition } = await import(project.root + '/.build/app.ts')
      const env = { name: 'node' }
      const first = await createApp(definition, { env })
      try {
        const second = await createApp(definition, { env })
        try {
          for (const instance of [first, second, first]) {
            const response = await instance.fetch(new Request('https://example.test/'))
            expect(response.status).toBe(200)
            expect(await response.text()).toContain(`"sub":"node-${instance === first ? 1 : 2}"`)
          }
        } finally {
          await second.close()
        }
      } finally {
        await first.close()
      }
    } finally {
      project.remove()
    }
  })

  it('rejects invalid page factory settings before the Node instance serves requests', async () => {
    const project = pageProject('node')
    try {
      const { definition } = await import(project.root + '/.build/app.ts')
      await expect(createApp(definition, { env: {} })).rejects.toThrow('name is required')
    } finally {
      project.remove()
    }
  })

  it('resolves each Workers event and reuses its result for internal API calls', async () => {
    const project = pageProject('cloudflare')
    try {
      const { definition } = await import(project.root + '/.build/app.ts')
      const worker = createWorkerHandler(definition, true)
      const env = { name: 'worker' }
      const context = { waitUntil() {}, passThroughOnException() {} }
      for (const version of [1, 2]) {
        const response = await worker.fetch(new Request('https://example.test/'), env, context)
        expect(response.status).toBe(200)
        expect(await response.text()).toContain(`"sub":"worker-${version}"`)
      }
    } finally {
      project.remove()
    }
  })
})
