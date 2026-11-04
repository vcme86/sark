import type { ServerResponse } from 'node:http'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { defineNodeRuntime } from '../../src/adapter/node/runtime'
import { getCurrentScope } from '../../src/app/context'
import { createDefinition } from '../../src/app/definition'
import type { RouteEntry } from '../../src/app/http/assembly'
import { route } from '../../src/app/http/route'
import type { DisposalContext } from '../../src/app/resource'
import { defineDatabase } from '../../src/features/db/sqlite'
import { parseApiFilePath } from '../../src/http/path'
import { sark } from '../../src/tooling/vite'
import { createDevHandoff } from '../helpers/dev-handoff'
import { createProject } from '../helpers/project'

async function fixture(
  routes: RouteEntry[],
  dispose?: (context: DisposalContext) => Promise<void>,
) {
  const project = createProject()
  project.write('app.ts', 'export const app = {}')
  const envKey = 'SARK_HANDOFF_' + crypto.randomUUID().replaceAll('-', '')
  project.write('.env.development', `${envKey}=current-environment`)
  const database = defineDatabase({ filename: ':memory:' })
  const create = database.createStatic!
  const clients: { open: boolean }[] = []
  const definition = createDefinition({
    resources: {
      db: {
        ...database,
        async createStatic(...args: Parameters<typeof create>) {
          const result = await create(...args)
          clients.push(result.value.$client)
          return {
            value: result.value,
            async dispose(context: DisposalContext) {
              await result.dispose?.(context)
              await dispose?.(context)
            },
          }
        },
      },
    },
    routes: [
      ...routes,
      {
        routePath: parseApiFilePath('ping.get.ts', '/api')!,
        declaration: route().handler(() => ({ ok: true })),
      },
    ],
  })
  const factory = vi.fn((env: NodeJS.ProcessEnv) => {
    expect(env[envKey]).toBe('current-environment')
    return { shutdown: { deadline: 1000, reserve: 500 } }
  })
  const runtime = defineNodeRuntime(factory)
  const load = vi.fn(async () => ({ definition, runtime }))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  let harness: Awaited<ReturnType<typeof createDevHandoff>>
  try {
    harness = await createDevHandoff(project.root, sark(), load)
  } catch (failure) {
    project.remove()
    warning.mockRestore()
    error.mockRestore()
    throw failure
  }
  return {
    ...harness,
    clients,
    load,
    factory,
    warning,
    error,
    update: () => harness.invalidate(join(project.root, 'app.ts')),
    async close() {
      try {
        await harness.close()
      } finally {
        project.remove()
        warning.mockRestore()
        error.mockRestore()
      }
    },
  }
}

function eventStream(cancel: () => void): RouteEntry {
  return {
    routePath: parseApiFilePath('events.get.ts', '/api')!,
    declaration: route().handler(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: connected\n\n'))
            },
            cancel,
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    ),
  }
}

it('cancels a persistent stream and replaces the instance using one resolved runtime per instance', async () => {
  const cancelled = Promise.withResolvers<void>()
  const harness = await fixture([eventStream(cancelled.resolve)])
  let control: ServerResponse | undefined
  harness.use((request, response, next) => {
    if (request.url !== '/vite-control') return next()
    control = response
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.write('before:')
  })
  const controlResponse = await harness.request('/vite-control')
  const controlBody = controlResponse.text().catch((error: unknown) => error)
  const response = await harness.request('/api/events')
  const body = response.text().catch((error: unknown) => error)
  try {
    expect(harness.clients[0].open).toBe(true)
    expect(harness.factory).toHaveBeenCalledTimes(1)
    await harness.update()
    await cancelled.promise
    expect(await body).toBeInstanceOf(Error)
    expect(harness.clients[0].open).toBe(false)
    expect(harness.warning).toHaveBeenCalledTimes(1)
    expect(harness.warning.mock.calls[0][1]).toMatchObject({ connections: 1, handlers: 1 })
    expect(harness.error).not.toHaveBeenCalled()
    const replacement = await harness.request('/api/ping')
    expect(replacement.status).toBe(200)
    expect(await replacement.json()).toEqual({ ok: true })
    expect(harness.clients).toHaveLength(2)
    expect(harness.factory).toHaveBeenCalledTimes(2)
    expect(harness.load).toHaveBeenCalledTimes(2)
    expect(control?.destroyed).toBe(false)
    control!.end('after')
    expect(await controlBody).toBe('before:after')
  } finally {
    control?.end()
    await controlBody
    await harness.close()
  }
})

it('keeps resources while a cancelled handler is still awaiting non-cancellable work', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const handlerDone = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  const harness = await fixture([
    {
      routePath: parseApiFilePath('slow.get.ts', '/api')!,
      declaration: route().handler(async () => {
        const scope = getCurrentScope()!
        signal = scope.signal
        const db = scope.resources!.db as { $client: { open: boolean } }
        entered.resolve()
        await release.promise
        expect(db.$client.open).toBe(true)
        handlerDone.resolve()
        return { done: true }
      }),
    },
  ])
  const pending = harness.request('/api/slow').catch((error: unknown) => error)
  try {
    await entered.promise
    await harness.update()
    expect(signal?.aborted).toBe(true)
    expect(harness.clients[0].open).toBe(true)
    const blocked = await harness.request('/api/ping')
    expect(blocked.status).toBe(500)
    expect(await blocked.text()).toContain('previous instance is still closing')
    expect(harness.load).toHaveBeenCalledTimes(1)
    await harness.update()
    expect(harness.warning).toHaveBeenCalledTimes(1)
    release.resolve()
    await handlerDone.promise
    await expect.poll(() => harness.clients[0].open).toBe(false)
    const replacement = await harness.request('/api/ping')
    expect(replacement.status).toBe(200)
    await replacement.text()
    expect(harness.load).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve()
    await pending
    await harness.close()
  }
})

it('does not mistake a real disposal failure for the expected handoff cancellation', async () => {
  const cancelled = Promise.withResolvers<void>()
  const harness = await fixture([eventStream(cancelled.resolve)], async () => {
    throw new Error('dispose failed after cancellation')
  })
  const response = await harness.request('/api/events')
  const body = response.text().catch((error: unknown) => error)
  try {
    await harness.update()
    await cancelled.promise
    await body
    expect(harness.clients[0].open).toBe(false)
    const blocked = await harness.request('/api/ping')
    expect(blocked.status).toBe(500)
    expect(await blocked.text()).toContain('previous instance disposal failed')
    expect(harness.load).toHaveBeenCalledTimes(1)
    expect(harness.error).toHaveBeenCalled()
  } finally {
    await harness.close()
  }
})

it('retains an unfinished disposer after the deadline and resumes only after actual cleanup', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let first = true
  let disposal: DisposalContext | undefined
  const harness = await fixture([], async (context) => {
    if (!first) return
    first = false
    disposal = context
    entered.resolve()
    await release.promise
  })
  try {
    await (await harness.request('/api/ping')).text()
    const update = harness.update()
    await entered.promise
    await update
    expect(disposal?.signal.aborted).toBe(false)
    expect(harness.error).toHaveBeenCalledWith(
      '[sark][dev] Module reload failed:',
      expect.objectContaining({ message: expect.stringContaining('shutdown deadline') }),
    )
    const blocked = await harness.request('/api/ping')
    expect(blocked.status).toBe(500)
    await blocked.text()
    expect(harness.load).toHaveBeenCalledTimes(1)
    expect(harness.warning).not.toHaveBeenCalled()
    release.resolve()
    await expect.poll(async () => (await harness.request('/api/ping')).status).toBe(200)
    expect(harness.load).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve()
    await harness.close()
  }
})
