import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/entries/root'
import { generateProject } from '../../src/tooling/build/project'
import { createProject } from '../helpers/project'

describe('generated page routing', () => {
  it('rejects API/page GET collisions during generation, including differently named parameters', () => {
    const project = createProject()
    try {
      project.write('app.ts', '')
      project.write('app/[id].tsx', 'export default function Page() { return <h1>Page</h1> }')
      project.write(
        'api/[name].get.ts',
        "import { route } from '@olivaw/sark'; export default route().handler(() => 'api')",
      )
      expect(() => generateProject(project.root, { apiPrefix: '/' })).toThrow('Route conflict')
    } finally {
      project.remove()
    }
  })

  it('delivers decoded single parameters and wildcard arrays through real Hono page matching', async () => {
    const project = createProject()
    try {
      project.write('app.ts', '')
      project.write(
        'app/files/[...path].tsx',
        'export default function Page({ params }) { return <h1>{JSON.stringify(params.path)}</h1> }',
      )
      generateProject(project.root)
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const response = await app.fetch(
          new Request('https://example.test/files/hello%20world/second'),
        )
        expect(response.status).toBe(200)
        const html = await response.text()
        const payload = JSON.parse(
          html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
        )
        expect(html).toContain('[&quot;hello world&quot;,&quot;second&quot;]')
        expect(payload.request).not.toHaveProperty('params')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('uses native scope-only middleware policy and preserves canonical URL redirects', async () => {
    const project = createProject()
    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark'; export const app = defineApp({ cors: { origin: 'https://consumer.test' } })`,
    )
    project.write('app/_middleware.ts', 'export const scope = { cors: false }')
    project.write(
      'app/posts/[id].tsx',
      'export default function Page({ params }) { return <h1>{params.id}</h1> }',
    )
    generateProject(project.root)
    const { definition } = await import(project.root + '/.build/app.ts')
    const app = await createApp(definition)
    try {
      const response = await app.fetch(
        new Request('https://example.test/POSTS/Hello', {
          headers: { Origin: 'https://consumer.test' },
        }),
      )
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://example.test/posts/Hello')
      const canonical = await app.fetch(new Request(response.headers.get('location')!))
      expect(canonical.status).toBe(200)
      expect(await canonical.text()).toContain('<h1>Hello</h1>')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await app.close()
      project.remove()
    }
  })
})

it('recovers repeated slashes only for winning page aliases and preserves API ownership', async () => {
  const project = createProject()
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
export const app = defineApp({ trailingSlash: 'always' })`,
  )
  project.write(
    'app/posts/[id].tsx',
    'export default function Page({ params }) { return <h1>{params.id}</h1> }',
  )
  project.write(
    'app/files/[...path].tsx',
    'export default function Page() { return <h1>Files</h1> }',
  )
  project.write(
    'api/posts/[...path].get.ts',
    "import { route } from '@olivaw/sark'; export default route().handler(() => ({ api: true }))",
  )
  generateProject(project.root)
  const { definition } = await import(project.root + '/.build/app.ts')
  const app = await createApp(definition)
  try {
    for (const path of ['/POSTS//42?q=one', '//posts///42?q=one']) {
      const response = await app.fetch(new Request('https://example.test' + path))
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://example.test/posts/42/?q=one')
      const canonical = await app.fetch(new Request(response.headers.get('location')!))
      expect(canonical.status).toBe(200)
      expect(await canonical.text()).toContain('<h1>42</h1>')
    }
    const head = await app.fetch(new Request('https://example.test/posts//42', { method: 'HEAD' }))
    expect(head.status).toBe(308)
    expect(head.body).toBeNull()
    const api = await app.fetch(new Request('https://example.test/api/posts//42/'))
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ api: true })
    const emptyWildcard = await app.fetch(new Request('https://example.test/files//'))
    expect(emptyWildcard.headers.get('location')).toBe('https://example.test/files/')
    const encoded = await app.fetch(new Request('https://example.test/posts/a%2Fb/'))
    expect(encoded.status).toBe(200)
    expect(await encoded.text()).toContain('<h1>a/b</h1>')
    const write = await app.fetch(
      new Request('https://example.test/posts//42', {
        method: 'POST',
        headers: { origin: 'https://example.test' },
      }),
    )
    expect(write.status).not.toBe(308)
  } finally {
    await app.close()
    project.remove()
  }
})
