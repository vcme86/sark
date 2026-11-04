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
      ...(fixture.route ? { 'api/users.get.ts': fixture.route } : {}),
      ...(fixture.schema ? { 'schema.ts': fixture.schema } : {}),
      ...(fixture.contracts ? { 'contracts.ts': fixture.contracts } : {}),
      ...fixture.files,
    },
    { target: fixture.target, customHost: fixture.customHost },
  )
}

const sqliteSchema = `import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'
export const users = sqliteTable('users', {id: integer('id').primaryKey(), name: text('name').notNull()})
export const posts = sqliteTable('posts', {id: integer('id').primaryKey(), userId: integer('user_id').notNull()})
export const usersRelations = relations(users, ({many}) => ({posts: many(posts)}))
export const postsRelations = relations(posts, ({one}) => ({user: one(users, {fields: [posts.userId], references: [users.id]})}))
`

function expectCompiled(result: Awaited<ReturnType<typeof compileFixture>>) {
  expect(result.status, result.output).toBe(0)
}

describe('Database generated type contracts', () => {
  it('preserves SQLite schema, relations, native client and instance results', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineDatabase } from '@olivaw/sark/db/sqlite'
import * as schema from './schema'
export const database = defineDatabase({filename: ':memory:', schema})`,
        schema: sqliteSchema,
        contracts: `import { createApp } from '@olivaw/sark'
import { definition } from './.build/app'
const instance = await createApp(definition)
const memory: boolean = instance.db.$client.memory
// @ts-expect-error SQLite does not expose a postgres.js connection pool.
instance.db.$client.end()
// @ts-expect-error Importing SQLite must not introduce a global D1 type.
declare const unrelated: D1Database
`,
        route: `import { route } from '@olivaw/sark'
export default route().handler(async c => {
  const rows = await c.var.db.query.users.findMany({with: {posts: true}})
  const id: number = rows[0].posts[0].id
  // @ts-expect-error The database result name is a string, not any.
  const wrong: number = rows[0].name
  // @ts-expect-error The schema does not contain this relation.
  c.var.db.query.unknownTable.findMany()
  return {id}
})`,
      }),
    )
  })

  it('preserves PostgreSQL async queries and native client', async () => {
    expectCompiled(
      await compileFixture({
        schema: `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
export const users = pgTable('users', {id: integer('id').primaryKey(), name: text('name').notNull()})`,
        app: `import { defineDatabase } from '@olivaw/sark/db/postgres'
import * as schema from './schema'
export const database = defineDatabase((env: NodeJS.ProcessEnv) => ({url: env.DATABASE_URL, schema}))`,
        route: `import { route } from '@olivaw/sark'
import { users } from '../schema'
export default route().handler(async c => {
  const rows = await c.var.db.select().from(users)
  const name: string = rows[0].name
  // @ts-expect-error The selected name is a string.
  const wrong: number = rows[0].name
  // @ts-expect-error PostgreSQL queries do not have a synchronous SQLite all method.
  c.var.db.select().from(users).all()
  const timeout: number = c.var.db.$client.options.connect_timeout
  return {name, timeout}
})`,
      }),
    )
  })

  it('checks the Worker entry, registered Env and official D1 client types', async () => {
    expectCompiled(
      await compileFixture({
        target: 'cloudflare',
        schema: sqliteSchema,
        files: {
          'worker-configuration.d.ts': `import type { D1Database } from '@cloudflare/workers-types'
declare global { interface Env { DB: D1Database } }
export {}`,
        },
        app: `import { defineDatabase } from '@olivaw/sark/db/d1'
import * as schema from './schema'
export const database = defineDatabase((env: Env) => ({binding: env.DB, schema}))`,
        route: `import { route } from '@olivaw/sark'
import { users } from '../schema'
export default route().handler(async c => {
  const rows = await c.var.db.select().from(users)
  const name: string = rows[0].name
  // @ts-expect-error Native D1 prepared statements have no arbitrary methods.
  c.var.db.$client.prepare('select 1').unknownMethod()
  // @ts-expect-error Registered Env has no OTHER binding.
  c.env.OTHER.prepare('select 1')
  // @ts-expect-error The database result name is not any.
  const wrong: number = rows[0].name
  return {name, result: await c.env.DB.prepare('select 1').first<number>()}
})`,
      }),
    )
  })

  it('requires env for an unknown-input factory and preserves resource environment intersections', async () => {
    expectCompiled(
      await compileFixture({
        customHost: true,
        app: `import { defineDatabase } from '@olivaw/sark/db/sqlite'
export const database = defineDatabase((_env: unknown) => ({filename: ':memory:'}))`,
        contracts: `import { createApp, defineApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { createDefinition } from '@olivaw/sark/runtime/core'
import { definition } from './.build/app'
// @ts-expect-error An unknown-input factory still requires an explicit environment.
createApp(definition)
createApp(definition, {env: {}})
const combined = createDefinition({
  app: defineApp((env: {PORT: number}) => ({headers: {'X-Port': String(env.PORT)}})),
  resources: {
    db: defineDatabase((env: {FILE: string}) => ({filename: env.FILE})),
    staticValue: {async createStatic() {return {value: 1}}},
    unusedEnv: defineDatabase((_env: unknown) => ({filename: ':memory:'})),
  },
})
// @ts-expect-error A resource factory cannot lose its environment requirement.
createApp(combined)
// @ts-expect-error FILE is required despite other static or unknown-input resources.
createApp(combined, {env: {PORT: 3000}})
// @ts-expect-error PORT is required by the app factory.
createApp(combined, {env: {FILE: ':memory:'}})
createApp(combined, {env: {PORT: 3000, FILE: ':memory:'}})
`,
      }),
    )
  })

  it('rejects a Node standard entry whose ProcessEnv cannot satisfy the database factory', async () => {
    const result = await compileFixture({
      app: `import { defineDatabase } from '@olivaw/sark/db/sqlite'
export const database = defineDatabase((env: {FILE: string}) => ({filename: env.FILE}))`,
    })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('.build/start.ts')
    expect(result.output).toContain('ProcessEnv')
  })

  it('exposes neither db nor database SDK types when no database is selected', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark'
export const app = defineApp({})`,
        contracts: `import { createApp } from '@olivaw/sark'
import { definition } from './.build/app'
const instance = await createApp(definition)
// @ts-expect-error No database resource was selected.
instance.db
// @ts-expect-error No D1 type is introduced by the core entry.
declare const binding: D1Database`,
        route: `import { route } from '@olivaw/sark'
export default route().handler(c => {
  // @ts-expect-error No database resource was selected.
  return c.var.db
})`,
      }),
    )
  })
})
