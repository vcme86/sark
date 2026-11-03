import { configure, configureSync, getConfig, type LogRecord, reset } from '@logtape/logtape'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { getCurrentScope } from '../../src/core/context'
import { defineJobs } from '../../src/entries/jobs'
import { defineLogging } from '../../src/entries/logging'
import { createDefinition } from '../../src/entries/runtime/core'
import { getLogger, route } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'

let previous: ReturnType<typeof getConfig>
beforeEach(() => {
  previous = getConfig()
})
afterEach(async () => {
  await reset()
  if (previous) await configure(previous)
})

function eventContext() {
  const work: Promise<unknown>[] = []
  return {
    work,
    waitUntil(promise: Promise<unknown>) {
      work.push(promise)
    },
    passThroughOnException() {},
  }
}

it('isolates concurrent Worker sinks through deferred body reads and emits one access record per event', async () => {
  const events = new Map<string, { records: LogRecord[]; disposed: boolean }>()
  const handler = createWorkerHandler(
    createDefinition({
      logging: defineLogging((env: { name: string }) => {
        const event = { records: [] as LogRecord[], disposed: false }
        events.set(env.name, event)
        return {
          access: ['collector'],
          categories: { app: ['collector'] },
          sinks: {
            collector: () =>
              Object.assign(
                (record: LogRecord) => {
                  event.records.push(record)
                },
                {
                  [Symbol.dispose]() {
                    event.disposed = true
                  },
                },
              ),
          },
        }
      }),
      routes: [
        {
          routePath: parseApiFilePath('stream.get.ts', '/api')!,
          declaration: route().handler(() => {
            getLogger().info('handler')
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    expect(getCurrentScope()?.signal).toBeInstanceOf(AbortSignal)
                    getLogger().info('body')
                    controller.enqueue(new TextEncoder().encode('done'))
                    controller.close()
                  },
                },
                { highWaterMark: 0 },
              ),
            )
          }),
        },
      ],
    }),
  )
  const first = eventContext(),
    second = eventContext()
  const a = await handler.fetch(new Request('https://worker.test/api/stream'), { name: 'a' }, first)
  const b = await handler.fetch(
    new Request('https://worker.test/api/stream'),
    { name: 'b' },
    second,
  )
  try {
    expect([...events.values()].every((event) => !event.disposed)).toBe(true)
    expect(await b.text()).toBe('done')
    await Promise.all(second.work)
    expect(events.get('a')!.disposed).toBe(false)
    expect(await a.text()).toBe('done')
    await Promise.all(first.work)
    for (const event of events.values()) {
      expect(event.records.filter((record) => record.message.includes('handler'))).toHaveLength(1)
      const body = event.records.find((record) => record.message.includes('body'))!
      const access = event.records.filter((record) => record.category.join('/') === 'sark/access')
      expect(access).toHaveLength(1)
      expect(body.properties.requestId).toBe(access[0].properties.requestId)
      expect(event.disposed).toBe(true)
    }
    expect(events.get('a')!.records[0].properties.requestId).not.toBe(
      events.get('b')!.records[0].properties.requestId,
    )
  } finally {
    if (!a.bodyUsed) await a.body?.cancel()
    if (!b.bodyUsed) await b.body?.cancel()
    await Promise.allSettled([...first.work, ...second.work])
  }
})

it('keeps the platform lifetime pending until async sink disposal finishes', async () => {
  const releasing = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const ctx = eventContext()
  const handler = createWorkerHandler(
    createDefinition({
      logging: defineLogging({
        sinks: {
          remote: () =>
            Object.assign(() => {}, {
              async [Symbol.asyncDispose]() {
                releasing.resolve()
                await release.promise
              },
            }),
        },
      }),
    }),
  )
  const response = await handler.fetch(new Request('https://worker.test/missing'), {}, ctx)
  await response.text()
  let finished = false
  const completion = Promise.all(ctx.work).then(() => {
    finished = true
  })
  try {
    await releasing.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finished).toBe(false)
  } finally {
    release.resolve()
    await completion
  }
  expect(finished).toBe(true)
})

it('propagates async sink disposal failure to platform waitUntil', async () => {
  const failure = new Error('remote flush failed')
  const ctx = eventContext()
  const handler = createWorkerHandler(
    createDefinition({
      logging: defineLogging({
        sinks: {
          remote: () =>
            Object.assign(() => {}, {
              async [Symbol.asyncDispose]() {
                throw failure
              },
            }),
        },
      }),
    }),
  )
  const response = await handler.fetch(new Request('https://worker.test/missing'), {}, ctx)
  await response.text()
  await expect(Promise.all(ctx.work)).rejects.toThrow()
})

it('returns a setup error and releases untransferred sinks when an external logger has no scope carrier', async () => {
  configureSync({
    sinks: { host: () => {} },
    loggers: [{ category: ['app'], sinks: ['host'] }],
    reset: true,
  })
  let disposed = 0
  const ctx = eventContext()
  const handler = createWorkerHandler(
    createDefinition({
      logging: defineLogging({
        sinks: {
          remote: () =>
            Object.assign(() => {}, {
              [Symbol.dispose]() {
                disposed++
              },
            }),
        },
      }),
    }),
  )
  const response = await handler.fetch(new Request('https://worker.test/missing'), {}, ctx)
  expect(response.status).toBe(500)
  await response.text()
  expect(disposed).toBe(1)
  const outcomes = await Promise.allSettled(ctx.work)
  expect(outcomes.some((outcome) => outcome.status === 'rejected')).toBe(true)
})

it('retains the Scheduled logging scope through service cleanup and async sink disposal', async () => {
  const records: LogRecord[] = []
  let disposed = false
  const jobs = defineJobs([
    {
      name: 'cleanup',
      onCron: '0 * * * *',
      handler: ({ logger }) => {
        logger.info('scheduled work')
      },
    },
  ])
  const ctx = eventContext()
  const handler = createWorkerHandler(
    createDefinition({
      jobs,
      triggers: { crons: ['0 * * * *'] },
      logging: defineLogging({
        categories: { app: ['remote'] },
        sinks: {
          remote: () =>
            Object.assign(
              (record: LogRecord) => {
                records.push(record)
              },
              {
                async [Symbol.asyncDispose]() {
                  await Promise.resolve()
                  disposed = true
                },
              },
            ),
        },
      }),
      resources: {
        connection: {
          createForEvent: () => ({
            value: {},
            dispose() {
              getLogger().info('connection closed')
            },
          }),
        },
      },
    }),
  )
  await handler.scheduled!({ cron: '0 * * * *', scheduledTime: Date.now(), noRetry() {} }, {}, ctx)
  await Promise.all(ctx.work)
  expect(records.some((record) => record.message.includes('scheduled work'))).toBe(true)
  expect(records.some((record) => record.message.includes('connection closed'))).toBe(true)
  expect(disposed).toBe(true)
})
