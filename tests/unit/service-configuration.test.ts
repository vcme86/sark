import { expect, it } from 'vitest'

import { resolveHttpConfig } from '../../src/http/config'
import { createOAuthAssembly } from '../../src/services/auth/oauth/assembly'
import { defineOAuth } from '../../src/services/auth/oauth/config'
import { createAuthAssembly } from '../../src/services/auth/session/assembly'
import { defineAuth } from '../../src/services/auth/session/config'

it('resolves static session settings once per runtime, after host configuration is available', async () => {
  let reads = 0
  const assembly = createAuthAssembly(
    defineAuth({
      get secret() {
        reads++
        return 'session-secret-at-least-32-bytes-long'
      },
    }),
  )
  const runtime = assembly.createRuntime()
  expect(reads).toBe(0)
  const config = resolveHttpConfig({}, true)
  await runtime.prepare({}, config)
  const initial = reads
  expect(initial).toBeGreaterThan(0)
  await runtime.prepare({ NEXT: true }, config)
  expect(reads).toBe(initial)
  await assembly.createRuntime().prepare({}, config)
  expect(reads).toBeGreaterThan(initial)
})

it('reuses static OAuth providers while retaining per-runtime ownership', async () => {
  let reads = 0
  const assembly = createOAuthAssembly(
    defineOAuth([
      {
        id: 'github',
        kind: 'github',
        clientId: 'client',
        clientSecret: 'secret',
        get scopes() {
          reads++
          return []
        },
        redirectUri: 'https://example.test/callback',
        onSuccess() {},
      },
    ]),
    '/api',
  )
  const runtime = assembly.createRuntime()
  expect(reads).toBe(0)
  const first = await runtime.prepare(
    {},
    resolveHttpConfig({ cookie: { secret: 'first-cookie-secret' } }),
  )
  const initial = reads
  expect(initial).toBeGreaterThan(0)
  const second = await runtime.prepare(
    {},
    resolveHttpConfig({ cookie: { secret: 'second-cookie-secret' } }),
  )
  expect(reads).toBe(initial)
  expect(second.routes).toBe(first.routes)
  await assembly
    .createRuntime()
    .prepare({}, resolveHttpConfig({ cookie: { secret: 'third-cookie-secret' } }))
  expect(reads).toBeGreaterThan(initial)
})

it('validates missing environment secrets at the session entry for both signing modes', () => {
  const config = resolveHttpConfig()
  for (const declaration of [
    defineAuth((env: NodeJS.ProcessEnv) => ({ secret: env.AUTH_SECRET })),
    defineAuth((env: NodeJS.ProcessEnv) => ({
      keys: [{ kid: 'current', secret: env.AUTH_SECRET }],
    })),
  ]) {
    expect(() => createAuthAssembly(declaration).createRuntime().prepare({}, config)).toThrow(
      /Signing.*must be a string/,
    )
    expect(
      createAuthAssembly(declaration)
        .createRuntime()
        .prepare({ AUTH_SECRET: 'session-secret-at-least-32-bytes-long' }, config),
    ).toBeDefined()
  }
})

it('validates missing OAuth environment credentials before resource creation', () => {
  const declaration = defineOAuth((env: NodeJS.ProcessEnv) => [
    {
      id: 'github',
      kind: 'github',
      clientId: env.OAUTH_ID,
      clientSecret: env.OAUTH_SECRET,
      scopes: [],
      redirectUri: env.OAUTH_REDIRECT,
      onSuccess() {},
    },
  ])
  const config = resolveHttpConfig({ cookie: { secret: 'oauth-cookie-secret' } })
  const env = {
    OAUTH_ID: 'client',
    OAUTH_SECRET: 'secret',
    OAUTH_REDIRECT: 'https://example.test/callback',
  }
  for (const field of ['OAUTH_ID', 'OAUTH_SECRET', 'OAUTH_REDIRECT']) {
    expect(() =>
      createOAuthAssembly(declaration, '/api')
        .createRuntime()
        .prepare({ ...env, [field]: undefined }, config),
    ).toThrow(/OAuth/)
  }
  expect(
    createOAuthAssembly(declaration, '/api').createRuntime().prepare(env, config),
  ).toBeDefined()
})
