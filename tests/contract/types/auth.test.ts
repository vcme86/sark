import { describe, expect, it } from 'vitest'

import { checkGeneratedTypes } from '../../helpers/typecheck'

interface Fixture {
  app: string
  route?: string
  schema?: string
  contracts?: string
  files?: Record<string, string>
  target?: 'node' | 'cloudflare'
  customHost?: boolean
}

function compileFixture(fixture: Fixture) {
  return checkGeneratedTypes(
    {
      'app.ts': fixture.app,
      ...(fixture.route ? { 'api/test.get.ts': fixture.route } : {}),
      ...(fixture.schema ? { 'schema.ts': fixture.schema } : {}),
      ...(fixture.contracts ? { 'contracts.ts': fixture.contracts } : {}),
      ...fixture.files,
    },
    { target: fixture.target, customHost: fixture.customHost },
  )
}

const sqliteSchema = `import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core'
export const users = sqliteTable('users', {id: integer('id').primaryKey(), name: text('name').notNull()})
`

function expectCompiled(result: Awaited<ReturnType<typeof compileFixture>>) {
  expect(result.status, result.output).toBe(0)
}

describe('Auth & OAuth generated type contracts (P5)', () => {
  it('connects RegisteredResources to AuthCheckContext and rejects nonexistent methods', async () => {
    expectCompiled(
      await compileFixture({
        schema: sqliteSchema,
        app: `import { defineApp } from '@olivaw/sark/server'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineAuth } from '@olivaw/sark/auth/session'
import * as schema from './schema'

export const app = defineApp({ hosts: 'localhost', middleware: [async (ctx, next) => {
  const rows = await ctx.var.db.query.users.findMany()
  const name: string = rows[0].name
  const sub: string | undefined = ctx.var.auth.identity?.sub
  // @ts-expect-error Middleware preserves the actual database schema.
  ctx.var.db.query.unknownTable.findMany()
  // @ts-expect-error Middleware preserves request auth methods.
  ctx.var.auth.verify('token')
  await next()
}] })
export const database = defineDatabase({ filename: ':memory:', schema })
export const auth = defineAuth({
  secret: 'a-very-long-secret-key-of-at-least-32-characters-123',
  validate: async (identity, { db }) => {
    const rows = await db.query.users.findMany()
    const name: string = rows[0].name
    // @ts-expect-error Name is string, not number
    const wrong: number = rows[0].name
    // @ts-expect-error Unknown table does not exist on typed schema
    db.query.unknownTable.findMany()
    return true
  },
})
`,
        contracts: `import { createApp } from '@olivaw/sark/server'
import { defineAuth } from '@olivaw/sark/auth/session'
defineAuth((env: NodeJS.ProcessEnv) => ({ secret: env.AUTH_SECRET }))
defineAuth((env: NodeJS.ProcessEnv) => ({ keys: [{ kid: 'current', secret: env.AUTH_SECRET }] }))
// @ts-expect-error A required signing mode must still be supplied.
defineAuth({})
// @ts-expect-error Signing modes remain mutually exclusive.
defineAuth({ secret: 'secret', keys: [] })
import { definition } from './.build/app'
import type { RequestAuth } from './.build/types'

declare const requestAuth: RequestAuth
const subject: string | undefined = requestAuth.identity?.sub
requestAuth.signOut()
// @ts-expect-error Generated request auth is distinct from instance verification.
requestAuth.verify('token')

const instance = await createApp(definition)
const auth = instance.auth
const verified = await auth.verify('jwt-token')
// @ts-expect-error Internal method issue is not exposed on instance.auth
auth.issue({ sub: 'user_1' })
// @ts-expect-error Internal method renew is not exposed on instance.auth
auth.renew
// @ts-expect-error Internal method initRequestSession is not exposed on instance.auth
auth.initRequestSession
// @ts-expect-error Nonexistent property on instance
instance.nonexistent
`,
        route: `import { route } from '@olivaw/sark/server'
export default route().handler(async c => {
  const currentIdentity = c.var.auth.identity
  if (currentIdentity) {
    const sub: string = currentIdentity.sub
  }
  return { ok: true }
})`,
      }),
    )
  })

  it('connects RegisteredResources to OAuth onSuccess ctx.var and rejects nonexistent properties', async () => {
    expectCompiled(
      await compileFixture({
        schema: sqliteSchema,
        app: `import { defineApp } from '@olivaw/sark/server'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineOAuth } from '@olivaw/sark/auth/oauth'
import * as schema from './schema'

export const app = defineApp({
  hosts: 'localhost',
  cookie: { secret: 'secret-for-signing-oauth-cookie-123456!' },
})
export const database = defineDatabase({ filename: ':memory:', schema })
export const oauth = defineOAuth([
  {
    id: 'github',
    kind: 'github',
    clientId: 'gh-id',
    clientSecret: 'gh-secret',
    scopes: ['user:email'],
    redirectUri: 'http://localhost/auth/github/callback',
    onSuccess: async (profile, tokens, ctx) => {
      const rows = await ctx.var.db.query.users.findMany()
      const name: string = rows[0].name
      // @ts-expect-error db does not have nonexistentMethod
      ctx.var.db.nonexistentMethod()
      // @ts-expect-error ctx.var does not have nonexistentVar
      ctx.var.nonexistentVar
    },
  },
])
`,
      }),
    )
  })

  it('supports app with auth but without database', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark/server'
import { defineAuth } from '@olivaw/sark/auth/session'

export const app = defineApp({ hosts: 'localhost' })
export const auth = defineAuth({
  secret: 'a-very-long-secret-key-of-at-least-32-characters-123',
})
`,
        route: `import { route } from '@olivaw/sark/server'
export default route().handler(async c => {
  const id = c.var.auth.identity?.sub
  // @ts-expect-error No database is declared in this application
  const db = c.var.db
  return { id }
})`,
      }),
    )
  })

  it('retains factory Env requirements and omits auth from OAuth-only instances', async () => {
    expectCompiled(
      await compileFixture({
        customHost: true,
        app: `import { defineAuth } from '@olivaw/sark/auth/session'
import { defineOAuth } from '@olivaw/sark/auth/oauth'
export const auth = defineAuth((env: { AUTH_SECRET: string }) => ({ secret: env.AUTH_SECRET }))
export const oauth = defineOAuth((env: { CLIENT_ID: string }) => [{
  id: 'github', kind: 'github',
        clientSecret: 'test-client-secret', clientId: env.CLIENT_ID, scopes: [],
  redirectUri: 'https://example.com/callback', onSuccess() {},
}])`,
        contracts: `import { createApp } from '@olivaw/sark/server'
import { createDefinition } from '@olivaw/sark/runtime/core'
import { createOAuthAssembly } from '@olivaw/sark/runtime/oauth'
import { oauth } from './app'
import { definition } from './.build/app'
// @ts-expect-error Factory environment is required
createApp(definition)
// @ts-expect-error OAuth factory's client ID is also required
createApp(definition, { env: { AUTH_SECRET: 'secret' } })
const instance = await createApp(definition, { env: { AUTH_SECRET: 'secret', CLIENT_ID: 'id' } })
instance.auth.verify('token')
const oauthOnly = createDefinition({ services: { oauth: createOAuthAssembly(oauth, '/api') } })
// @ts-expect-error OAuth environment is required
createApp(oauthOnly)
const external = await createApp(oauthOnly, { env: { CLIENT_ID: 'id' } })
// @ts-expect-error OAuth does not expose a first-party authentication service
external.auth
`,
      }),
    )
  })

  it('preserves clean Services type when auth is not declared', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark/server'

export const app = defineApp({ hosts: 'localhost' })
`,
        route: `import { route } from '@olivaw/sark/server'
export default route().handler(async c => {
  // @ts-expect-error auth is not available when not declared
  const a = c.var.auth
  return { ok: true }
})`,
      }),
    )
  })
})
