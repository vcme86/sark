import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createSocket } from 'node:net'
import { join } from 'node:path'

import { preview } from 'vite'
import { expect, it } from 'vitest'

import { createPageProject } from '../helpers/page-project'
import { runProjectCli, serverUrl } from '../helpers/project'

const secret = 'a-production-session-secret-at-least-32-bytes'

for (const target of ['node', 'cloudflare'] as const) {
  it(`runs generated session/OIDC/SSR composition in the production ${target} host`, async () => {
    const project = createPageProject(target)
    project.write(
      'app.ts',
      `import './mock-idp'
import { defineApp } from '@olivaw/sark'
import { defineAuth } from '@olivaw/sark/auth'
import { defineOAuth } from '@olivaw/sark/auth/oauth'
export const app = defineApp({ csrf: false, cookie: { secret: 'oauth-cookie-secret-with-enough-length' } })
export const auth = defineAuth({ secret: '${secret}', cookie: { secure: false }, expiresIn: 60000 })
export const oauth = defineOAuth([{
  id: 'test', kind: 'oidc', issuer: 'https://idp.example.test',
  clientId: 'test-client', clientSecret: 'test-secret', scopes: ['openid'],
  callbackPath: '/account/callback',
  redirectUri: 'https://public.example.test/account/callback?application=reader',
  async onSuccess(profile, tokens, ctx) {
    await ctx.var.auth.signIn({ sub: profile.subject, roles: ['reader'], claims: { private: 'not-in-bootstrap' } })
    return ctx.json({ sub: profile.subject, accessToken: tokens.accessToken })
  },
}])`,
    )
    // This fixture replaces the remote IdP, while the real SDK, WebCrypto and host run unchanged.
    project.write(
      'mock-idp.ts',
      `import { sign } from 'hono/jwt'
const nativeFetch = globalThis.fetch
let nonce
let challenge
let key
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === 'https://idp.example.test/.well-known/openid-configuration') return Response.json({
    issuer: 'https://idp.example.test', authorization_endpoint: 'https://idp.example.test/authorize',
    token_endpoint: 'https://idp.example.test/token', response_types_supported: ['code'],
    subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  })
  if (url === 'https://idp.example.test/token') {
    const body = new URLSearchParams(init.body)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier'))))
    const actual = btoa(String.fromCharCode(...digest)).replace(/=/g, '').replace(/\\+/g, '-').replace(/\\//g, '_')
    if (actual !== challenge || body.get('redirect_uri') !== 'https://public.example.test/account/callback?application=reader') throw new Error('Invalid token request')
    const now = Math.floor(Date.now() / 1000)
    key ??= crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign', 'verify'])
    return Response.json({ access_token: 'provider-access-token', token_type: 'Bearer', id_token: await sign({
      iss: 'https://idp.example.test', aud: 'test-client', sub: 'reader-42', iat: now, exp: now + 600, nonce,
    }, (await key).privateKey, 'RS256') })
  }
  return nativeFetch(input, init)
}
export function authorize(input) { const url = new URL(input); nonce = url.searchParams.get('nonce'); challenge = url.searchParams.get('code_challenge') }
`,
    )
    project.write(
      'api/authorize.post.ts',
      `import { route, z } from '@olivaw/sark'
import { authorize } from '../mock-idp'
export default route().validate({ text: z.string() }).handler((_ctx, input) => { authorize(input.text); return null })`,
    )
    project.write(
      'api/me.get.ts',
      `import { route } from '@olivaw/sark'
export default route().handler(ctx => ({ sub: ctx.var.auth.identity?.sub ?? null }))`,
    )
    project.write(
      'api/signout.post.ts',
      `import { route } from '@olivaw/sark'
export default route().handler(async ctx => { await ctx.var.auth.signOut(); return null })`,
    )
    project.write(
      'app/account.tsx',
      `export async function loader({ client }) { return client.get('/me') }
export default function Account({ data }) { return <h1>{data.sub ?? 'anonymous'}</h1> }`,
    )

    let close: (() => Promise<void>) | undefined
    try {
      const built = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
      expect(built.status, built.stdout + built.stderr).toBe(0)
      let origin: string
      if (target === 'cloudflare') {
        const server = await preview({
          root: project.root,
          logLevel: 'silent',
          preview: { host: '127.0.0.1', port: 0 },
        })
        origin = serverUrl(server.httpServer)
        close = () => server.close()
      } else {
        const socket = createSocket()
        await new Promise<void>((ready) => socket.listen(0, '127.0.0.1', ready))
        const address = socket.address()
        if (!address || typeof address === 'string') throw new Error('Missing port')
        const port = address.port
        await new Promise<void>((ready) => socket.close(() => ready()))
        const child = spawn(process.execPath, [join(project.root, 'dist/server.mjs')], {
          cwd: project.root,
          env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let diagnostics = ''
        child.stdout.on('data', (data) => {
          diagnostics += data
        })
        child.stderr.on('data', (data) => {
          diagnostics += data
        })
        const exited = once(child, 'exit')
        close = async () => {
          child.kill('SIGTERM')
          await exited
        }
        origin = `http://127.0.0.1:${port}`
        await expect
          .poll(
            async () => {
              if (child.exitCode !== null) throw new Error(diagnostics)
              try {
                return (await fetch(origin + '/livez')).status
              } catch {
                return 0
              }
            },
            { timeout: 15000 },
          )
          .toBe(200)
      }
      const login = await fetch(origin + '/service/v2/auth/test/signin', { redirect: 'manual' })
      expect(login.status, await login.clone().text()).toBe(302)
      const oldEntry = await fetch(origin + '/auth/test/signin', { redirect: 'manual' })
      expect(oldEntry.status).toBe(404)
      const authorization = login.headers.get('Location')!
      const state = new URL(authorization).searchParams.get('state')!
      const cookie = login.headers.getSetCookie()[0].split(';')[0]
      await fetch(origin + '/service/v2/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: authorization,
      })
      const callback = await fetch(
        origin + `/account/callback?application=reader&code=issued-code&state=${state}`,
        { headers: { Cookie: cookie } },
      )
      expect(callback.status, await callback.clone().text()).toBe(200)
      expect(await callback.json()).toEqual({
        sub: 'reader-42',
        accessToken: 'provider-access-token',
      })
      const session = callback.headers
        .getSetCookie()
        .find((value) => value.startsWith('auth_token='))!
      expect(session).toContain('HttpOnly')
      expect(session).not.toContain('Secure')
      const sessionCookie = session.split(';')[0]
      const page = await fetch(origin + '/site/account', {
        headers: { Cookie: sessionCookie, Accept: 'text/html' },
      })
      const html = await page.text()
      expect(page.status, html).toBe(200)
      expect(html).toContain('<h1>reader-42</h1>')
      const bootstrap = JSON.parse(
        html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
      )
      expect(bootstrap.request.identity).toEqual({ user: { sub: 'reader-42', roles: ['reader'] } })
      expect(html).not.toContain('not-in-bootstrap')
      expect(html).not.toContain('provider-access-token')
      const logout = await fetch(origin + '/service/v2/signout', {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      })
      expect(logout.headers.getSetCookie()[0]).toMatch(/auth_token=;.*Max-Age=0/)
      expect((await (await fetch(origin + '/service/v2/me')).json()).sub).toBeNull()
    } finally {
      try {
        await close?.()
      } finally {
        project.remove()
      }
    }
  }, 60000)
}
