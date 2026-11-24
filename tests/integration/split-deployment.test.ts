import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import {
  createProject,
  projectRoot,
  runProjectCli,
  serverUrl,
  startNodeProject,
} from '../helpers/project'
import { checkTypes } from '../helpers/typecheck'

it('serves independently built pages and API behind one public origin', async () => {
  const project = createProject()
  let api: Awaited<ReturnType<typeof startNodeProject>> | undefined
  let page: Awaited<ReturnType<typeof startNodeProject>> | undefined
  const gateway = createServer((incoming, outgoing) => {
    const path = incoming.url ?? '/'
    const apiRequest = path.startsWith('/backend/')
    const target = apiRequest ? api : page
    if (!target) {
      outgoing.writeHead(503).end()
      return
    }
    const upstreamPath = apiRequest ? '/api' + path.slice('/backend'.length) : path
    const upstream = request(
      new URL(upstreamPath, target.origin),
      {
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode!, response.headers)
        response.pipe(outgoing)
      },
    )
    upstream.on('error', () => outgoing.writeHead(502).end())
    incoming.pipe(upstream)
  })

  try {
    project.write(
      'contract.ts',
      `
export type Api = {
  '/profile': { GET: { input: {}; output: { subject: string | null } } }
}
`,
    )
    project.write(
      'api-service/vite.config.ts',
      `
import { sark } from '@olivaw/sark/vite'
export default { plugins: [sark({ webDir: false })] }
`,
    )
    project.write(
      'api-service/app.ts',
      `
import { defineAuth } from '@olivaw/sark/auth'
import { defineNodeRuntime } from '@olivaw/sark/node'

export const auth = defineAuth({
  secret: 'split-deployment-test-key-at-least-32-bytes',
  cookie: { secure: false },
})
export const runtime = defineNodeRuntime({ hostname: '127.0.0.1' })
`,
    )
    project.write(
      'api-service/api/session.post.ts',
      `
import { route, z } from '@olivaw/sark'

export default route()
  .validate({ json: z.object({ token: z.literal('fixture-token') }) })
  .handler(async (c) => {
    await c.var.auth.signIn({ sub: 'reader' })
    return c.body(null, 204)
  })
`,
    )
    project.write(
      'api-service/api/profile.get.ts',
      `
import { route } from '@olivaw/sark'
import type { Api } from '../../contract'

export default route().handler((c): Api['/profile']['GET']['output'] => {
  const { identity } = c.var.auth
  if (identity) c.header('Set-Cookie', 'locale=en; Path=/; SameSite=Lax')
  c.header('Cache-Control', 'private, no-store')
  return { subject: identity?.sub ?? null }
})
`,
    )
    project.write(
      'page-service/vite.config.ts',
      `
import { sark } from '@olivaw/sark/vite'
import react from '@vitejs/plugin-react'
export default { plugins: [react(), sark({ apiDir: false, apiTypes: '../contract' })] }
`,
    )
    project.write(
      'page-service/app.ts',
      `
import { defineNodeRuntime } from '@olivaw/sark/node'
import { definePage } from '@olivaw/sark/page'

export const runtime = defineNodeRuntime({ hostname: '127.0.0.1' })
export const page = definePage((env: NodeJS.ProcessEnv) => ({
  api: { serverUrl: env.INTERNAL_API_URL, browserUrl: '/backend' },
  async identity({ client, signal }) {
    const { subject } = await client.get('/profile', { init: { signal } })
    return { user: subject ? { sub: subject } : null }
  },
}))
`,
    )
    project.write(
      'page-service/app/index.tsx',
      `
import type { LoaderArgs } from '@olivaw/sark/page'

export function loader({ identity }: LoaderArgs) {
  return { subject: identity.user?.sub }
}

export default function Home({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  return data.subject ? <h1>Profile: {data.subject}</h1> : <h1>Sign in required</h1>
}
`,
    )
    const apiRoot = join(project.root, 'api-service')
    const pageRoot = join(project.root, 'page-service')
    for (const [directory, root] of [
      ['api-service', apiRoot],
      ['page-service', pageRoot],
    ]) {
      project.write(
        `${directory}/tsconfig.json`,
        JSON.stringify({
          extends: join(projectRoot, 'tsconfig.json'),
          include: ['app.ts', 'api', 'app', '.build/**/*'],
        }),
      )
      const build = runProjectCli(root, ['build'])
      expect(build.status, build.stdout + build.stderr).toBe(0)
      const types = checkTypes(root)
      expect(types.status, types.output).toBe(0)
    }
    api = await startNodeProject(apiRoot)
    page = await startNodeProject(pageRoot, { INTERNAL_API_URL: api.origin + '/api' })
    gateway.listen(0, '127.0.0.1')
    await once(gateway, 'listening')
    const origin = serverUrl(gateway)

    const anonymous = await fetch(origin, { headers: { Accept: 'text/html' } })
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).toContain('<h1>Sign in required</h1>')

    const login = await fetch(origin + '/backend/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ token: 'fixture-token' }),
    })
    expect(login.status, await login.text()).toBe(204)
    const cookie = login.headers.getSetCookie()[0]
    expect(cookie).toContain('HttpOnly')
    const headers = { Cookie: cookie.split(';', 1)[0], Accept: 'text/html' }
    const profile = await fetch(origin, { headers })
    const html = await profile.text()
    expect(profile.status, html).toBe(200)
    expect(html).toContain('Profile: <!-- -->reader')
    expect(html).not.toContain(api.origin)
    expect(html).not.toContain(headers.Cookie)
    expect(profile.headers.getSetCookie()).toEqual(['locale=en; Path=/; SameSite=Lax'])
    expect(profile.headers.get('cache-control')).toContain('private')
    const bootstrap = JSON.parse(
      html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
    )
    expect(bootstrap.config?.api).toEqual({ browserUrl: '/backend' })
    expect(bootstrap.request.identity).toEqual({ user: { sub: 'reader' } })
    const publicProfile = await fetch(origin + bootstrap.config.api.browserUrl + '/profile', {
      headers: { Cookie: headers.Cookie },
    })
    expect(publicProfile.status).toBe(200)
    expect(await publicProfile.json()).toEqual({ subject: 'reader' })

    expect(await api.stop()).toEqual([0, null])
    const unavailable = await fetch(origin, { headers })
    expect(unavailable.status).toBe(500)
    expect(await unavailable.text()).toContain('<h1>Server Error</h1>')
    expect((await fetch(page.origin + '/readyz')).status).toBe(200)
  } finally {
    gateway.close()
    await Promise.all([api?.stop(), page?.stop()])
    project.remove()
  }
}, 45_000)
