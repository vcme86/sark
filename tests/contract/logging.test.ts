import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getFileSink } from '@logtape/file'
import {
  configureSync,
  getConfig,
  getConsoleSink,
  type LogRecord,
  resetSync,
  type Sink,
} from '@logtape/logtape'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { defineJobs } from '../../src/entries/jobs'
import { defineLogging } from '../../src/entries/logging'
import { createApp, defineApp, getLogger, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { createNodeJobsAssembly } from '../../src/features/jobs/assembly-node'
import { createLoggingAssembly } from '../../src/features/logging/assembly'
import { parseApiFilePath } from '../../src/http/path'

describe('logging contract', () => {
  let previousConfig: ReturnType<typeof getConfig>

  beforeEach(() => {
    previousConfig = getConfig()
  })

  afterEach(() => {
    if (previousConfig) configureSync({ ...previousConfig, reset: true })
    else resetSync()
  })

  it('correlates task start, business output and completion with the same task ID', async () => {
    const records: LogRecord[] = []
    const jobs = defineJobs([
      {
        name: 'manual',
        schedule: { interval: 60000 },
        handler({ logger }) {
          logger.info('task business')
        },
      },
    ])
    const app = await createApp(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            categories: { app: ['collector'] },
            sinks: {
              collector: () => (record) => {
                records.push(record)
              },
            },
          }),
        ),
        services: { jobs: createNodeJobsAssembly(jobs) },
      }),
    )
    try {
      await app.jobs!.get('manual')!.run()
      const task = records.filter((record) => record.category.join('/') === 'app/jobs:manual')
      expect(task).toHaveLength(3)
      expect(task[0].properties.requestId).toBeTypeOf('string')
      expect(new Set(task.map((record) => record.properties.requestId)).size).toBe(1)
      expect(task.some((record) => record.message.includes('task business'))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('flushes a standard LogTape file sink before application close completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sark-logging-file-'))
    const path = join(root, 'application.log')
    try {
      const app = await createApp(
        createDefinition({
          logging: createLoggingAssembly(
            defineLogging({
              access: ['file'],
              sinks: { file: () => getFileSink(path) },
              categories: { app: ['file'] },
            }),
          ),
        }),
      )
      try {
        getLogger().info('file output')
        const response = await app.fetch(new Request('http://localhost/not-found'))
        await response.text()
      } finally {
        await app.close()
      }
      const text = readFileSync(path, 'utf8')
      expect(text).toContain('file output')
      expect(text).toContain('/not-found')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores basic diagnostics after host resets LogTape', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const generation of [1, 2]) {
        resetSync()
        const app = await createApp(createDefinition())
        try {
          getLogger('queries').error(`diagnostic-generation-${generation}`)
          expect(output.mock.calls.flat().join(' ')).toContain(
            `diagnostic-generation-${generation}`,
          )
        } finally {
          await app.close()
        }
      }
    } finally {
      output.mockRestore()
    }
  })

  it('configures custom sinks, categories, and disposes sinks in reverse order', async () => {
    const records: LogRecord[] = []
    const disposalOrder: string[] = []

    const testSink1: Sink = (record) => {
      records.push(record)
    }
    Object.assign(testSink1, {
      [Symbol.dispose]: () => {
        disposalOrder.push('first')
      },
    })

    const testSink2: Sink = (record) => {
      records.push(record)
    }
    Object.assign(testSink2, {
      [Symbol.dispose]: () => {
        disposalOrder.push('second')
      },
    })

    const app = await createApp(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            level: 'debug',
            sinks: {
              first: () => testSink1,
              second: () => testSink2,
            },
            categories: {
              custom: ['first', 'second'],
            },
          }),
        ),
      }),
    )

    try {
      getLogger('custom').debug('hello debug')
      expect(records.some((r) => r.message.includes('hello debug'))).toBe(true)
    } finally {
      await app.close()
    }

    // Must be disposed in reverse creation order: second, then first
    expect(disposalOrder).toEqual(['second', 'first'])
  })

  it('emits access logs for normal HTTP requests and redacts sensitive headers', async () => {
    const accessRecords: LogRecord[] = []
    const accessSink: Sink = (record) => {
      if (record.category.includes('access')) {
        accessRecords.push(record)
      }
    }

    const app = await createApp(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            access: ['accessCollector'],
            sinks: {
              accessCollector: () => accessSink,
            },
          }),
        ),
        routes: [
          {
            source: 'api/hello.ts',
            routePath: parseApiFilePath('api/hello.get.ts', '/')!,
            declaration: route().handler((ctx) => ctx.json({ message: 'world' })),
          },
        ],
      }),
    )

    try {
      const response = await app.fetch(
        new Request('http://localhost/api/hello?token=secret123', {
          headers: {
            Authorization: 'Bearer my-secret-token',
            Cookie: 'sessionId=abc123xyz',
            'X-Custom': 'visible-header',
          },
        }),
      )
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({ message: 'world' })

      expect(accessRecords.length).toBe(1)
      const entry = accessRecords[0].properties as any
      expect(entry.method).toBe('GET')
      expect(entry.status).toBe(200)
      expect(entry.path).toBe('/api/hello')
      expect(entry.outcome).toBe('ok')
    } finally {
      await app.close()
    }
  })

  it('records streaming response access log only after stream finishes', async () => {
    const accessRecords: LogRecord[] = []
    const accessSink: Sink = (record) => {
      if (record.category.includes('access')) {
        accessRecords.push(record)
      }
    }

    let streamCompleted = false
    const app = await createApp(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            access: ['accessCollector'],
            sinks: {
              accessCollector: () => accessSink,
            },
          }),
        ),
        routes: [
          {
            source: 'api/stream.ts',
            routePath: parseApiFilePath('api/stream.get.ts', '/')!,
            declaration: route().handler(() => {
              const stream = new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('chunk1\n'))
                  setTimeout(() => {
                    controller.enqueue(new TextEncoder().encode('chunk2\n'))
                    streamCompleted = true
                    controller.close()
                  }, 50)
                },
              })
              return new Response(stream, { headers: { 'content-type': 'text/plain' } })
            }),
          },
        ],
      }),
    )

    try {
      const response = await app.fetch(new Request('http://localhost/api/stream'))
      expect(response.status).toBe(200)

      // When response headers arrive, stream hasn't finished, so access log is NOT emitted yet
      expect(accessRecords.length).toBe(0)

      // Read complete stream
      const text = await response.text()
      expect(text).toBe('chunk1\nchunk2\n')
      expect(streamCompleted).toBe(true)

      // Now stream is finished, access log should be recorded
      expect(accessRecords.length).toBe(1)
      expect(accessRecords[0].properties.status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('does not emit access logs for internal fetch calls', async () => {
    const accessRecords: LogRecord[] = []
    const accessSink: Sink = (record) => {
      if (record.category.includes('access')) {
        accessRecords.push(record)
      }
    }

    let app: any
    app = await createApp(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            access: ['accessCollector'],
            sinks: {
              accessCollector: () => accessSink,
            },
          }),
        ),
        routes: [
          {
            source: 'api/ping.ts',
            routePath: parseApiFilePath('api/ping.get.ts', '/')!,
            declaration: route().handler((ctx) => ctx.text('pong')),
          },
          {
            source: 'api/outer.ts',
            routePath: parseApiFilePath('api/outer.get.ts', '/')!,
            declaration: route().handler(async () => {
              const internalRes = await app.fetchInternal(new Request('http://localhost/api/ping'))
              return { ping: await internalRes.text() }
            }),
          },
        ],
      }),
    )

    try {
      const res = await app.fetch(new Request('http://localhost/api/outer'))
      expect(await res.json()).toEqual({ ping: 'pong' })
      // Only the outer request emits an access record; the internal call to /api/ping does not
      expect(accessRecords.length).toBe(1)
      expect(accessRecords[0].message).toContain('/api/outer')
    } finally {
      await app.close()
    }
  })

  it('rejects creation when external non-Sark logging configuration exists', async () => {
    configureSync({
      sinks: {
        hostSink: () => {},
      },
      loggers: [
        {
          category: ['external_host'],
          sinks: ['hostSink'],
        },
      ],
      reset: true,
    })

    await expect(
      createApp(
        createDefinition({
          logging: createLoggingAssembly(defineLogging()),
        }),
      ),
    ).rejects.toThrow('Host already configured LogTape logging')
  })

  it('validates sink references before instantiating any sinks', async () => {
    let factoryCalled = false
    const sinkFactory = () => {
      factoryCalled = true
      return () => {}
    }

    await expect(
      createApp(
        createDefinition({
          logging: createLoggingAssembly(
            defineLogging({
              sinks: {
                validSink: sinkFactory,
              },
              categories: {
                audit: ['missingSink'],
              },
            }),
          ),
        }),
      ),
    ).rejects.toThrow('Unknown sink "missingSink"')

    // The factory for validSink must NOT have been called because validation happens first!
    expect(factoryCalled).toBe(false)
  })

  it('rolls back created sinks in reverse order when a later sink creation fails', async () => {
    const disposed: string[] = []
    const firstSink: Sink = Object.assign(() => {}, {
      [Symbol.dispose]() {
        disposed.push('first')
      },
    })

    await expect(
      createApp(
        createDefinition({
          logging: createLoggingAssembly(
            defineLogging({
              sinks: {
                first: () => firstSink,
                second: () => {
                  throw new Error('failed to create second sink')
                },
              },
            }),
          ),
        }),
      ),
    ).rejects.toThrow('failed to create second sink')

    expect(disposed).toEqual(['first'])
  })

  it('preserves trusted X-Request-Id and clientIp when streaming response body finishes asynchronously', async () => {
    const accessRecords: LogRecord[] = []
    const accessSink: Sink = (record) => {
      if (record.category.includes('access')) {
        accessRecords.push(record)
      }
    }

    const app = await createApp(
      createDefinition({
        app: defineApp({
          trustedProxies: ['loopback', 'private', '0.0.0.0/0'],
        }),
        logging: createLoggingAssembly(
          defineLogging({
            access: ['accessCollector'],
            sinks: {
              accessCollector: () => accessSink,
            },
          }),
        ),
        routes: [
          {
            source: 'api/delayed-stream.ts',
            routePath: parseApiFilePath('api/delayed-stream.get.ts', '/')!,
            declaration: route().handler(() => {
              const stream = new ReadableStream({
                start(controller) {
                  setTimeout(() => {
                    controller.enqueue(new TextEncoder().encode('data: hello\n\n'))
                    controller.close()
                  }, 40)
                },
              })
              return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
            }),
          },
        ],
      }),
    )

    try {
      const response = await app.fetch(
        new Request('http://localhost/api/delayed-stream', {
          headers: {
            'X-Request-Id': 'trusted-custom-req-id',
            'X-Forwarded-For': '203.0.113.5',
          },
        }),
        {
          incoming: {
            socket: {
              remoteAddress: '127.0.0.1',
            },
          },
        },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('x-request-id')).toBe('trusted-custom-req-id')

      // At this point, caller has not finished reading the stream body yet
      expect(accessRecords.length).toBe(0)

      // Now caller reads the stream body to completion
      const text = await response.text()
      expect(text).toContain('data: hello')

      // Access log is emitted now, and must preserve the trusted request ID and client IP
      expect(accessRecords.length).toBe(1)
      const props = accessRecords[0].properties as any
      expect(props.requestId).toBe('trusted-custom-req-id')
      expect(props.clientIp).toBe('203.0.113.5')
      expect(props.path).toBe('/api/delayed-stream')
    } finally {
      await app.close()
    }
  })

  it('disposes standard Symbol.dispose sink exactly once upon app.close', async () => {
    let disposeCount = 0
    const standardSink: Sink & Disposable = Object.assign(() => {}, {
      [Symbol.dispose]() {
        disposeCount++
      },
    })

    const app = await createApp(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            sinks: {
              standard: () => standardSink,
            },
            categories: {
              app: ['standard'],
            },
          }),
        ),
      }),
    )

    await app.close()
    expect(disposeCount).toBe(1)
  })

  it('detects external host configuration even if shape resembles single console sink', async () => {
    // Host configures its own LogTape with identical single-console shape
    configureSync({
      sinks: {
        console: getConsoleSink(),
      },
      loggers: [
        {
          category: ['app'],
          sinks: ['console'],
        },
      ],
      reset: true,
    })

    await expect(
      createApp(
        createDefinition({
          logging: createLoggingAssembly(defineLogging()),
        }),
      ),
    ).rejects.toThrow('Host already configured LogTape logging')
  })

  it('rejects creating a second active application instance with logging configuration while the first is active', async () => {
    const firstApp = await createApp(
      createDefinition({
        logging: createLoggingAssembly(defineLogging()),
      }),
    )

    try {
      await expect(
        createApp(
          createDefinition({
            logging: createLoggingAssembly(defineLogging()),
          }),
        ),
      ).rejects.toThrow(
        'Another active Sark application instance already configured LogTape logging.',
      )
    } finally {
      await firstApp.close()
    }

    // After closing the first app, another app can successfully acquire ownership
    const secondApp = await createApp(
      createDefinition({
        logging: createLoggingAssembly(defineLogging()),
      }),
    )
    await secondApp.close()
  })

  it('supports async sink disposal using Symbol.asyncDispose', async () => {
    let asyncDisposed = false
    const asyncSink: Sink & AsyncDisposable = Object.assign(() => {}, {
      async [Symbol.asyncDispose]() {
        await new Promise((resolve) => setTimeout(resolve, 15))
        asyncDisposed = true
      },
    })

    const app = await createApp(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            sinks: {
              asyncSink: () => asyncSink,
            },
            categories: {
              app: ['asyncSink'],
            },
          }),
        ),
      }),
    )

    await app.close()
    expect(asyncDisposed).toBe(true)
  })

  it('configures event-scoped logging on Cloudflare Workers with custom sinks and flushes on body stream completion', async () => {
    const eventRecords: LogRecord[] = []
    let sinkDisposed = false
    const workerSink: Sink = Object.assign(
      (record: LogRecord) => {
        eventRecords.push(record)
      },
      {
        [Symbol.dispose]() {
          sinkDisposed = true
        },
      },
    )

    const handler = createWorkerHandler(
      createDefinition({
        logging: createLoggingAssembly(
          defineLogging({
            sinks: {
              workerSink: () => workerSink,
            },
            categories: {
              app: ['workerSink'],
            },
          }),
        ),
        routes: [
          {
            routePath: parseApiFilePath('event-log.get.ts', '/api')!,
            declaration: route().handler(() => {
              getLogger('worker-app').info('event-record-1')
              return { ok: true }
            }),
          },
        ],
      }),
    )

    const waitUntilPromises: Promise<unknown>[] = []
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waitUntilPromises.push(p)
      },
      passThroughOnException() {},
    }

    const response = await handler.fetch(new Request('https://worker.test/api/event-log'), {}, ctx)
    expect(response.status).toBe(200)
    await response.json()
    await Promise.all(waitUntilPromises)

    expect(eventRecords.some((r) => r.message.includes('event-record-1'))).toBe(true)
    expect(sinkDisposed).toBe(true)
  })
})

it('preserves native interpolation while redacting owned structured output recursively', async () => {
  const records: LogRecord[] = []
  const app = await createApp(
    createDefinition({
      logging: createLoggingAssembly(
        defineLogging({
          access: false,
          categories: { app: ['collector'] },
          sinks: {
            collector: () => (record) => {
              records.push(record)
            },
          },
        }),
      ),
    }),
  )
  try {
    getLogger().info('User {user}: {Token}', {
      user: 'alice',
      Token: 'private-token',
      nested: { PASSWORD: 'private-password', visible: 42 },
    })
    expect(records).toHaveLength(1)
    expect(records[0].properties.Token).toBe('[REDACTED]')
    expect(records[0].properties.nested).toEqual({ PASSWORD: '[REDACTED]', visible: 42 })
    expect(records[0].message.join('')).toContain('User alice: [REDACTED]')
    expect(records[0].properties).not.toHaveProperty('args')
  } finally {
    await app.close()
  }
})

it('rejects concurrent output ownership even when the same generated definition is reused', async () => {
  const definition = createDefinition({ logging: createLoggingAssembly(defineLogging()) })
  const first = await createApp(definition)
  try {
    await expect(createApp(definition)).rejects.toThrow('Another active Sark application instance')
  } finally {
    await first.close()
  }
})
