import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createProject, projectRoot } from '../../helpers/project'
import { checkGeneratedTypes, checkTypes } from '../../helpers/typecheck'

describe('generated HTTP type contracts', () => {
  it('checks request inputs, response types and generated client registration', async () => {
    const routes: Record<string, string> = {
      'files.[...path].get':
        'route().validate({ params: z.object({ path: z.string() }) }).handler((ctx, input) => ({ path: input.params.path, id: ctx.var.requestId }))',
      'search.get':
        'route().validate({ query: z.object({ term: z.string() }) }).handler((_c, input) => input.query)',
      'convert.post':
        'route().validate({ text: z.string().transform(Number) }).handler((_c, input) => ({ value: input.text }))',
      'custom.post': `route().validate({ text: {
        safeParse(value: unknown) { return { success: true, data: Number(value) } }
      } }).handler((_c, input) => {
        const value: number = input.text
        // @ts-expect-error Custom schema output is a number.
        const invalid: string = input.text
        // @ts-expect-error Undeclared schema fields are absent from handler input.
        input.params
        return { value }
      })`,
      'custom-async.post': `route().validate({ text: {
        async safeParseAsync(value: unknown) { return { success: true, data: Number(value) } }
      } }).handler((_c, input) => {
        const value: number = input.text
        // @ts-expect-error Asynchronous schema output is a number.
        const invalid: string = input.text
        return { value }
      })`,
      'optional.post':
        'route().validate({ json: z.object({ name: z.string() }).optional() }).handler((_c, input) => input.json ?? null)',
      'form.post':
        'route().validate({ form: z.object({ name: z.string() }) }).handler((_c, input) => input.form)',
      'fallback.all':
        'route().validate({ query: z.object({ term: z.string() }) }).handler((_c, input) => ({ fallback: input.query.term }))',
      'mixed.all':
        'route().validate({ json: z.object({ value: z.number() }) }).handler((_c, input) => ({ fallback: input.json.value }))',
      'mixed.get': 'route().handler(() => ({ specific: true }))',
      'lookup.query':
        'route().validate({ json: z.object({ term: z.string() }) }).handler((_c, input) => ({ found: input.json.term }))',
      'date.get': 'route().handler(() => ({ date: new Date() }))',
      'raw.get': "route().handler(() => new Response('hello'))",
      'text.get': "route().handler(ctx => ctx.text('hello'))",
      'empty.get': 'route().handler(ctx => ctx.body(null, 204))',
      'dynamic.get': `route().handler(ctx => {
        function status(): import('hono/utils/http-status').ContentfulStatusCode {
          return Math.random() > 0.5 ? 200 : 400
        }
        return ctx.json({ ok: true }, status())
      })`,
      'api.items.get': 'route().handler(() => [])',
      'read.[id].get': 'route().handler(ctx => ({ id: ctx.req.param("id") }))',
      'rawfiles.[...path].get': 'route().handler(ctx => ({ path: ctx.req.param("path") }))',
      'users.[id].get':
        'route().validate({ params: z.object({ id: z.string() }) }).handler((_c, input) => input.params)',
    }
    const files: Record<string, string> = {
      'app.ts': '',
      'contracts.ts': String.raw`
import { createClient } from '@olivaw/sark/http'
import { createApp, defineApp, route, type Context, type MiddlewareHandler } from '@olivaw/sark/server'
import { createDefinition } from '@olivaw/sark/runtime/core'
import { defineNodeRuntime } from '@olivaw/sark/server/node'
import type { TypedResponse } from 'hono'
import type { Api } from './.build/app'

const client = createClient<Api>({ baseUrl: 'https://example.test' })
const middleware: MiddlewareHandler = async (ctx, next) => {
  const requestId: string = ctx.var.requestId
  // @ts-expect-error Unselected services do not exist in typed middleware.
  ctx.var.nonexistentService.nonexistentMethod()
  await next()
}
defineApp({ middleware: [middleware, async (ctx, next) => {
  // @ts-expect-error Application middleware receives the declared context.
  ctx.var.nonexistentService.nonexistentMethod()
  await next()
}] })
route({ middleware: [async (ctx, next) => {
  // @ts-expect-error Route middleware receives the declared context.
  ctx.var.nonexistentService.nonexistentMethod()
  await next()
}] }).handler(() => null)
declare const context: Context
const requestId: string = context.var.requestId
const instance = await createApp(createDefinition())
// @ts-expect-error The mutable internal Hono router is not an application API.
instance.hono

client.get('/files/*path', { params: { path: 'guide/setup' } })
// @ts-expect-error Required catch-all parameters cannot be omitted.
client.get('/files/*path')
client.get('/search', { query: { term: 'book' } })
// @ts-expect-error Required query requires options.
client.get('/search')
// @ts-expect-error Required query cannot be omitted.
client.get('/search', {})
// @ts-expect-error Unknown route.
client.get('/missing')
// @ts-expect-error Wrong method.
client.post('/search')
// @ts-expect-error GET has no request body.
client.get('/search', { query: { term: 'book' }, json: {} })
client.get('/users/:id', { params: { id: 'Alice' } })
// @ts-expect-error Required path parameters cannot be omitted.
client.get('/users/:id')
client.post('/convert', { text: '42' })
// @ts-expect-error A required text body cannot be omitted.
client.post('/convert')
// @ts-expect-error Input before the transform is string.
client.post('/convert', { text: 42 })
const conflictingBody = { text: '42', json: {} }
// @ts-expect-error Conflicting body fields are rejected through variables too.
client.post('/convert', conflictingBody)
const custom: number = (await client.post('/custom', { text: '42' })).value
const customAsync: number = (await client.post('/custom-async', { text: '42' })).value
client.post('/optional')
client.post('/optional', { headers: { 'X-Example': 'value' } })
client.post('/form', { form: new FormData() })
client.post('/form', { form: new URLSearchParams({ name: 'Alice' }) })
client.post('/form', { form: { name: 'Alice' } })
// @ts-expect-error A required form body cannot be omitted.
client.post('/form')
client.head('/date')
client.get('/api/items')
const fallback: string = (await client.get('/fallback', { query: { term: 'book' } })).fallback
client.post('/fallback', { query: { term: 'book' } })
client.head('/fallback', { query: { term: 'book' } })
// @ts-expect-error ALL fallback retains required input.
client.get('/fallback')
// @ts-expect-error GET cannot acquire a request body through ALL.
client.get('/fallback', { query: { term: 'book' }, json: {} })
const specific: boolean = (await client.get('/mixed')).specific
const mixedFallback: number = (await client.post('/mixed', { json: { value: 42 } })).fallback
// @ts-expect-error The ALL fallback retains its required JSON body.
client.post('/mixed')
// @ts-expect-error A concrete method does not inherit ALL's input.
client.get('/mixed', { json: { value: 42 } })
const found: string = (await client.query('/lookup', { json: { term: 'book' } })).found
// @ts-expect-error QUERY retains required input.
client.query('/lookup')
// @ts-expect-error QUERY does not enable GET for the endpoint.
client.get('/lookup')
// @ts-expect-error Default registration must enforce the same routes.
createClient().get('/missing')
const date = await client.get('/date')
const iso: string = date.date
// @ts-expect-error JSON dates are strings.
const wrongDate: Date = date.date
const text: string = await client.get('/text')
const empty: undefined = await client.get('/empty')
const dynamic = await client.get('/dynamic')
const dynamicOk: boolean = dynamic.ok
// @ts-expect-error Hono requires StatusCode, not an unrestricted number.
type InvalidStatus = TypedResponse<{ ok: boolean }, number, 'json'>
const decoded = await client.get('/raw')
// @ts-expect-error A native Response has unknown decoded representation.
decoded.status
void [iso, wrongDate, text, empty, dynamicOk, fallback, specific, mixedFallback, found]

const requiresHost = defineApp((env: { REQUIRED_HOST: string }) => ({ hosts: env.REQUIRED_HOST }))
const unconstrained = defineNodeRuntime(() => ({ port: 0 }))
const definition = createDefinition({ app: requiresHost, declarations: [unconstrained] })
// @ts-expect-error An unconstrained factory must not erase the other factory requirement.
createApp(definition, { env: {} })
createApp(definition, { env: { REQUIRED_HOST: 'localhost' } })

type ResolvedHttp = Awaited<ReturnType<typeof createApp>>['config']
// @ts-expect-error Resolved Cookie attributes cannot remain optional downstream.
const incompleteCookie: ResolvedHttp['cookie'] = { secret: 'secret' }
// @ts-expect-error An unprocessed application option is not a resolved HTTP configuration.
const incompleteHttp: ResolvedHttp = { bodyLimit: 100 }
void [incompleteCookie, incompleteHttp]

client.get('/read/:id', { params: { id: 42 } })
client.get('/rawfiles/*path', { params: { path: 'guide/setup' } })
// @ts-expect-error File path parameters are required even without a validation schema.
client.get('/read/:id')
// @ts-expect-error File path parameter names are checked even without a validation schema.
client.get('/read/:id', { params: { missing: 'Alice' } })
// @ts-expect-error Catch-all parameters are required even without a validation schema.
client.get('/rawfiles/*path')
`,
    }
    for (const [name, declaration] of Object.entries(routes)) {
      files[`api/${name}.ts`] =
        `import { route, z } from '@olivaw/sark/server'\nexport default ${declaration}\n`
    }
    const result = await checkGeneratedTypes(files)
    expect(result.status, result.output).toBe(0)
  })

  it.each(['/api', '/v1/service', '/'])(
    'preserves relative paths and precise package registration with prefix %s',
    async (apiPrefix) => {
      const result = await checkGeneratedTypes(
        {
          'app.ts': '',
          'api/items.[id].get.ts': `import { route, z } from '@olivaw/sark/server'
export default route().validate({ params: z.object({ id: z.string() }) }).handler(() => ({ ok: true as const }))`,
          'contracts.ts': `import { createClient } from '@olivaw/sark/http'
import { useClient } from '@olivaw/sark/client'
import type { ActionArgs, LoaderArgs } from '@olivaw/sark/page'
const client = createClient()
const result: Promise<{ ok: true }> = client.get('/items/:id', { params: { id: '1' } })
// @ts-expect-error Default registration preserves the concrete result type.
const wrong: Promise<{ ok: false }> = client.get('/items/:id', { params: { id: '1' } })
// @ts-expect-error Required parameters cannot be omitted.
client.get('/items/:id')
// @ts-expect-error The configured API prefix is not part of the relative client path.
client.get('${apiPrefix === '/' ? '/api' : apiPrefix}/items/:id', { params: { id: '1' } })
// @ts-expect-error Unknown routes remain invalid.
client.get('/missing')

function checkPageClients(loader: LoaderArgs<{ id: string }>, action: ActionArgs<{ id: string }>) {
  for (const registered of [useClient(), loader.client, action.client]) {
    const result: Promise<{ ok: true }> = registered.get('/items/:id', { params: { id: '1' } })
    // @ts-expect-error Each entry retains the registered response type.
    const wrong: Promise<{ ok: false }> = registered.get('/items/:id', { params: { id: '1' } })
    // @ts-expect-error Each entry rejects undeclared endpoints.
    registered.get('/missing')
    // @ts-expect-error Each entry requires declared parameters.
    registered.get('/items/:id')
  }
}`,
        },
        { apiPrefix },
      )
      expect(result.status, result.output).toBe(0)
    },
  )

  it('checks source registration without package aliases or application generation', () => {
    const project = createProject()
    try {
      project.write(
        'contracts.ts',
        `import { createClient } from '../../src/entries/http'
import { useClient } from '../../src/entries/client'
import type { ActionArgs, LoaderArgs } from '../../src/entries/page'

declare module '../../src/entries/http' {
  interface Register {
    api: { '/items/:id': { GET: { input: { params: { id: string } }; output: { ok: true } } } }
  }
}

function checkClients(loader: LoaderArgs<{ id: string }>, action: ActionArgs<{ id: string }>) {
  for (const client of [createClient(), useClient(), loader.client, action.client]) {
    const result: Promise<{ ok: true }> = client.get('/items/:id', { params: { id: '1' } })
    // @ts-expect-error Registered source clients retain the exact response type.
    const wrong: Promise<{ ok: false }> = client.get('/items/:id', { params: { id: '1' } })
    // @ts-expect-error Registered source clients reject undeclared routes.
    client.get('/missing')
    // @ts-expect-error Registered source clients require path parameters.
    client.get('/items/:id')
  }
}`,
      )
      project.write(
        'tsconfig.json',
        JSON.stringify({
          extends: resolve(projectRoot, 'tsconfig.json'),
          include: ['contracts.ts'],
        }),
      )
      const result = checkTypes(project.root)
      expect(result.status, result.output).toBe(0)
    } finally {
      project.remove()
    }
  })

  it.each(['app', 'runtime'])(
    'rejects a narrower %s environment in the real Node entry',
    async (declaration) => {
      const result = await checkGeneratedTypes({
        'app.ts':
          declaration === 'app'
            ? `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp((env: { REQUIRED_HOST: string }) => ({ hosts: env.REQUIRED_HOST }))`
            : `import { defineNodeRuntime } from '@olivaw/sark/server/node'
export const runtime = defineNodeRuntime((env: { REQUIRED_PORT: string }) => ({ port: Number(env.REQUIRED_PORT) }))`,
      })
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('.build/start.ts')
      expect(result.output).toMatch(/(?:Type|Argument of type) 'ProcessEnv'/)
    },
  )

  it.each([true, false])(
    'checks the generated Worker entry against its declared Env (compatible=$0)',
    async (compatible) => {
      const result = await checkGeneratedTypes(
        {
          'app.ts': `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp((env: { REQUIRED_BINDING: string }) => ({ headers: { 'X-Binding': env.REQUIRED_BINDING } }))`,
          'worker-configuration.d.ts': `declare global { interface Env { ${compatible ? 'REQUIRED_BINDING' : 'OTHER_BINDING'}: string } }
export {}`,
        },
        { target: 'cloudflare' },
      )
      if (compatible) expect(result.status, result.output).toBe(0)
      else {
        expect(result.status).not.toBe(0)
        expect(result.output).toContain('.build/worker.ts')
        expect(result.output).toMatch(
          /(?:Property 'REQUIRED_BINDING' is missing|Type 'Env' is not assignable)/,
        )
      }
    },
  )
})
