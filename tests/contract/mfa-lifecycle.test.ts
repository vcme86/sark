import { expect, it, vi } from 'vitest'

import { defineApp, resolveAppConfig } from '../../src/app/config'
import { assembleApp, createApp } from '../../src/app/create'
import { createDefinition } from '../../src/app/definition'
import { route } from '../../src/app/http/route'
import type { ServiceAssembly } from '../../src/app/service'
import { AuthError } from '../../src/features/auth/error'
import { createMfaAssembly } from '../../src/features/auth/mfa/assembly'
import { defineMfa } from '../../src/features/auth/mfa/declaration'
import { createAuthAssembly } from '../../src/features/auth/session/assembly'
import { defineAuth } from '../../src/features/auth/session/config'
import type { RequestAuth } from '../../src/features/auth/session/types'
import { memoryState } from '../../src/features/auth/state/memory'
import { createTotpFactor } from '../../src/features/auth/totp/assembly'
import { defineTotp } from '../../src/features/auth/totp/config'
import type { RequestTotp } from '../../src/features/auth/totp/types'
import { parseApiFilePath } from '../../src/http/path'

it('creates fresh MFA stores for each application and disposes partial initialization once in reverse order', async () => {
  const disposed: string[] = []
  const seen: unknown[] = []
  const store = { read: async () => null, commit: async () => true }
  const mfa = defineMfa({
    state: {
      create: async (context) => {
        seen.push(context.env)
        return {
          value: (await memoryState().create(context)).value,
          dispose: () => {
            disposed.push('state')
          },
        }
      },
    },
  })
  const totp = defineTotp((env: { label: string }) => ({
    issuer: env.label,
    keys: { current: { id: 'key', key: new Uint8Array(32) } },
    store: {
      create: () => ({
        value: store,
        dispose: () => {
          disposed.push(env.label)
        },
      }),
    },
  }))
  const factor = createTotpFactor(totp)
  const definition = createDefinition({
    services: {
      auth: createAuthAssembly(
        defineAuth({ secret: 'long-enough-session-signing-secret-for-tests' }),
      ),
      mfa: createMfaAssembly({ mfa, factors: [factor] }),
      totp: factor.maintenance,
    },
  })
  const first = await createApp(definition, { env: { label: 'first' } })
  const second = await createApp(definition, { env: { label: 'second' } })
  expect(seen).toEqual([{ label: 'first' }, { label: 'second' }])
  await first.close()
  expect(disposed).toEqual(['first', 'state'])
  await second.close()
  expect(disposed).toEqual(['first', 'state', 'second', 'state'])

  disposed.length = 0
  const failure = new Error('factor initialization failed')
  const broken = createDefinition({
    services: {
      auth: createAuthAssembly(
        defineAuth({ secret: 'long-enough-session-signing-secret-for-tests' }),
      ),
      mfa: createMfaAssembly({
        mfa,
        factors: [
          {
            kind: 'totp',
            prepare: () => ({
              create: async (_context, _state, _policy, registerDispose) => {
                registerDispose('factor', () => {
                  disposed.push('factor')
                })
                throw failure
              },
            }),
          },
        ],
      }),
    },
  })
  await expect(createApp(broken)).rejects.toBe(failure)
  expect(disposed).toEqual(['factor', 'state'])
})

it.each(['end', 'cancel', 'error'] as const)(
  'disposes event-owned services once after response %s',
  async (ending) => {
    const dispose = vi.fn()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const service: ServiceAssembly<never> = {
      createRuntime: () => ({
        prepare: () => ({
          create(_resources, context) {
            context.registerDispose('owned', dispose)
            return {}
          },
        }),
      }),
    }
    const definition = createDefinition({
      app: defineApp({ csrf: false }),
      services: { owned: service },
      routes: [
        {
          routePath: parseApiFilePath('stream.get.ts', '/api')!,
          declaration: route().handler(
            () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    stream = controller
                  },
                }),
              ),
          ),
        },
      ],
    })
    const config = resolveAppConfig(definition.app, undefined, false)
    const app = await assembleApp(definition, {
      kind: 'event',
      resolve: () => config,
      errorConfig: config,
    })
    const work: Promise<unknown>[] = []
    try {
      const response = await app.fetch(
        new Request('http://localhost/api/stream'),
        {},
        { waitUntil: (promise: Promise<unknown>) => work.push(promise) },
      )
      expect(dispose).not.toHaveBeenCalled()
      if (ending === 'cancel') await response.body!.cancel()
      else if (ending === 'error') {
        stream.error(new Error('stream failed'))
        await expect(response.text()).rejects.toThrow('stream failed')
      } else {
        stream.close()
        await response.text()
      }
      await Promise.all(work)
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      await app.close()
    }
  },
)

it('retains event stores for tracked work without delaying response completion', async () => {
  const task = Promise.withResolvers<void>()
  const disposed = vi.fn()
  const work: Promise<unknown>[] = []
  const definition = createDefinition({
    services: {
      owned: {
        createRuntime: () => ({
          prepare: () => ({
            create(_resources, context) {
              context.registerDispose('owned', disposed)
              context.waitUntil(task.promise)
              return {}
            },
          }),
        }),
      },
    },
    routes: [
      {
        routePath: parseApiFilePath('test.get.ts', '/api')!,
        declaration: route().handler(() => ({ ready: true })),
      },
    ],
  })
  const config = resolveAppConfig(definition.app, undefined, false)
  const app = await assembleApp(definition, {
    kind: 'event',
    resolve: () => config,
    errorConfig: config,
  })
  try {
    const response = await app.fetch(
      new Request('http://localhost/api/test'),
      {},
      { waitUntil: (promise: Promise<unknown>) => work.push(promise) },
    )
    expect(await response.json()).toEqual({ ready: true })
    expect(disposed).not.toHaveBeenCalled()
    task.resolve()
    await Promise.all(work)
    expect(disposed).toHaveBeenCalledOnce()
  } finally {
    task.resolve()
    await app.close()
  }
})

it('initializes generated session, factor and maintenance services in their declared order', async () => {
  const calls: string[] = []
  const factor = createTotpFactor(
    defineTotp({
      issuer: 'test',
      keys: { current: { id: 'k', key: new Uint8Array(32) } },
      store: { create: () => ({ value: { read: async () => null, commit: async () => true } }) },
    }),
  )
  const mfa = createMfaAssembly({ factors: [factor] })
  const definition = createDefinition({
    services: {
      auth: createAuthAssembly(
        defineAuth({ secret: 'long-enough-session-signing-secret-for-tests' }),
      ),
      mfa,
      totp: factor.maintenance,
    },
    resources: {
      selected: {
        async createStatic() {
          calls.push('opened')
          return { value: {} }
        },
      },
    },
  })
  expect(Object.keys(definition.services!)).toEqual(['auth', 'mfa', 'totp'])
  const app = await createApp(definition)
  try {
    expect(typeof app.totp.reencrypt).toBe('function')
    expect(calls).toEqual(['opened'])
  } finally {
    await app.close()
  }
})

it('requires recent factor authentication when recovery codes are the remaining enrolled method', async () => {
  const readTotp = vi.fn(async () => null)
  const recovery = { revision: 'r', hashes: ['unused-code-hash'] }
  const factor = createTotpFactor(
    defineTotp({
      issuer: 'test',
      keys: { current: { id: 'k', key: new Uint8Array(32) } },
      store: { create: () => ({ value: { read: readTotp, commit: async () => true } }) },
    }),
  )
  const instance = await createApp(
    createDefinition({
      services: {
        auth: createAuthAssembly(
          defineAuth({ secret: 'long-enough-session-signing-secret-for-tests' }),
        ),
        mfa: createMfaAssembly({
          factors: [factor],
          mfa: defineMfa({
            recovery: {
              store: {
                create: () => ({ value: { read: async () => recovery, commit: async () => true } }),
              },
            },
          }),
        }),
      },
      routes: [
        {
          routePath: parseApiFilePath('enroll.get.ts', '/api')!,
          declaration: route().handler(async (ctx) => {
            const services = ctx.var as unknown as { auth: RequestAuth; totp: RequestTotp }
            await services.auth.signIn({
              sub: 'alice',
              amr: ['pwd'],
              authTime: Math.floor(Date.now() / 1000),
            })
            try {
              await services.totp.beginEnrollment()
              return { enrolled: true }
            } catch (error) {
              if (error instanceof AuthError) return { code: error.code }
              throw error
            }
          }),
        },
      ],
    }),
  )
  try {
    const response = await instance.fetch(new Request('http://localhost/api/enroll'))
    expect(await response.json()).toEqual({ code: 'step_up_required' })
    expect(readTotp).toHaveBeenCalledOnce()
  } finally {
    await instance.close()
  }
})
