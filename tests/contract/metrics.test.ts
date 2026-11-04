import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RouteEntry } from '../../src/app/http/assembly'
import { type DeliveryResult, requestDeliveries } from '../../src/app/http/delivery'
import { getWsUpgradeState } from '../../src/app/http/websocket'
import { defineJobs } from '../../src/entries/jobs'
import { defineMetrics } from '../../src/entries/node'
import {
  type AppInstance,
  createApp,
  defineApp,
  route,
  type RouteHandler,
} from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { createNodeJobsAssembly } from '../../src/entries/runtime/jobs-node'
import { createMetricsAssembly } from '../../src/entries/runtime/metrics'
import type { MetricsService } from '../../src/features/metrics/types'
import { parseApiFilePath } from '../../src/http/path'
import { generateBuildArtifacts } from '../../src/tooling/build/generate'
import { createProject } from '../helpers/project'

function testRoute(path: string, handler: RouteHandler): RouteEntry {
  const file = path.replace(/^\//, '').replace(/:([a-zA-Z0-9_]+)/g, '[$1]') + '.get.ts'
  return {
    routePath: parseApiFilePath(file, '/')!,
    declaration: route().handler(handler),
  }
}

describe('metrics contract', () => {
  it('omits metrics service when metrics is not declared', async () => {
    const app = await createApp(
      createDefinition({
        routes: [],
      }),
    )

    expect('metrics' in app).toBe(false)
    await app.close()
  })

  it('shares the metrics service between the instance and request bindings', async () => {
    let capturedCtxMetrics: MetricsService | undefined

    const app = await createApp(
      createDefinition({
        declarations: [defineMetrics({ path: '/app-metrics' })],
        services: {
          metrics: createMetricsAssembly(defineMetrics({ path: '/app-metrics' })),
        },
        routes: [
          testRoute('/api/test', (ctx) => {
            capturedCtxMetrics = (ctx.var as typeof ctx.var & { metrics: MetricsService }).metrics
            return { ok: true }
          }),
        ],
      }),
    )

    expect(app.metrics).toBeDefined()
    expect(typeof app.metrics.counter).toBe('function')
    expect(typeof app.metrics.histogram).toBe('function')
    expect(typeof app.metrics.gauge).toBe('function')

    const res = await app.fetch(new Request('http://localhost/api/test'))
    expect(res.status).toBe(200)
    expect(capturedCtxMetrics).toBe(app.metrics)

    await app.close()
  })

  it('reuses same metric specification and detects conflicting re-declarations', async () => {
    const app = await createApp(
      createDefinition({
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [],
      }),
    )

    const metrics = app.metrics

    const c1 = metrics.counter({ name: 'custom_events', help: 'Custom events' })
    const c2 = metrics.counter({ name: 'custom_events', help: 'Custom events' })
    expect(c1).toBe(c2)

    const c3 = metrics.counter({ name: 'custom_events_total', help: 'Custom events' })
    expect(c3).toBe(c1)

    expect(() => metrics.gauge({ name: 'custom_events', help: 'Custom events' })).toThrow(
      /Metric conflict/,
    )

    expect(() =>
      metrics.counter({ name: 'custom_events', help: 'Custom events', labels: ['type'] }),
    ).toThrow(/Metric conflict/)

    await app.close()
  })

  it('enforces required labels on counter and histogram recording calls', async () => {
    const app = await createApp(
      createDefinition({
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [],
      }),
    )

    const metrics = app.metrics
    const counterWithLabels = metrics.counter({
      name: 'purchases',
      help: 'Purchases count',
      labels: ['currency', 'status'],
    })

    expect(() => counterWithLabels.inc()).toThrow(/requires labels/)

    expect(() => counterWithLabels.inc({ currency: 'USD' })).toThrow(
      /missing required label: "status"/,
    )

    expect(() => counterWithLabels.inc({ currency: 'USD', status: 'success' })).not.toThrow()

    await app.close()
  })

  it('tracks external HTTP requests, status, and duration on /metrics endpoint', async () => {
    const app = await createApp(
      createDefinition({
        declarations: [defineMetrics()],
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [testRoute('/users/:id', () => ({ id: 123 }))],
      }),
    )

    const res1 = await app.fetch(new Request('http://localhost/users/42'))
    expect(res1.status).toBe(200)
    await res1.json()

    const metricsRes = await app.fetch(new Request('http://localhost/metrics'))
    expect(metricsRes.status).toBe(200)
    expect(metricsRes.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    expect(metricsRes.headers.get('cache-control')).toBe('no-store')

    const metricsText = await metricsRes.text()
    expect(metricsText).toContain('http_requests_total')
    expect(metricsText).toContain('route="/users/:id"')
    expect(metricsText).toContain('method="GET"')
    expect(metricsText).toContain('status="200"')

    expect(metricsText).toContain('http_request_duration_seconds')

    await app.close()
  })

  it.each(['http', 'websocket'] as const)(
    'records an unknown status for %s delivery failing before headers are confirmed',
    async (transport) => {
      const app = await createApp(
        createDefinition({
          services: { metrics: createMetricsAssembly(defineMetrics({ runtime: false })) },
          routes: [
            transport === 'http'
              ? testRoute('/test', () => 'ok')
              : {
                  routePath: parseApiFilePath('test.ws.ts', '/')!,
                  declaration: route().handler(() => ({})),
                },
          ],
        }),
      )
      let upgrade: ReturnType<typeof getWsUpgradeState>
      try {
        const request = new Request('http://localhost/test', {
          headers: transport === 'websocket' ? { upgrade: 'websocket' } : undefined,
        })
        const delivery = Promise.withResolvers<DeliveryResult>()
        if (transport === 'http') requestDeliveries.set(request, delivery.promise)
        const response = await app.fetch(request)
        if (transport === 'websocket') {
          upgrade = getWsUpgradeState(response)!
          const pending = await (await app.fetch(new Request('http://localhost/metrics'))).text()
          expect(pending).toContain('ws_connections_active 0')
          upgrade.complete!(undefined, 'error')
          upgrade.complete!(undefined, 'error')
          await upgrade.release!()
          await upgrade.release!()
        } else {
          delivery.resolve({ outcome: 'error' })
          await delivery.promise
        }
        await response.body?.cancel()
        const text = await (await app.fetch(new Request('http://localhost/metrics'))).text()
        expect(text).toContain('http_requests_total{method="GET",route="/test",status="unknown"} 1')
        expect(text).not.toContain('route="/test",status="200"')
        expect(text).toContain('ws_connections_active 0')
      } finally {
        await upgrade?.release?.()
        await app.close()
      }
    },
  )

  it.each(['throw', 'stream-error', 'cancel'] as const)(
    'notifies completion once for %s without a native delivery owner',
    async (ending) => {
      let cancellations = 0
      const app = await createApp(
        createDefinition({
          services: { metrics: createMetricsAssembly(defineMetrics({ runtime: false })) },
          routes: [
            testRoute('/completion', () => {
              if (ending === 'throw') throw new Error('handler failed')
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    if (ending === 'stream-error') controller.error(new Error('producer failed'))
                    else controller.enqueue(new TextEncoder().encode('first'))
                  },
                  cancel() {
                    cancellations++
                  },
                }),
              )
            }),
          ],
        }),
      )
      try {
        const response = await app.fetch(new Request('http://localhost/completion'))
        if (ending === 'stream-error')
          await expect(response.text()).rejects.toThrow('producer failed')
        else if (ending === 'cancel') {
          const reader = response.body!.getReader()
          await reader.read()
          await reader.cancel()
          reader.releaseLock()
          expect(cancellations).toBe(1)
        } else {
          expect(response.status).toBe(500)
          await response.text()
        }
        const text = await (await app.fetch(new Request('http://localhost/metrics'))).text()
        expect(text).toContain('http_active_requests 1\n')
        expect(text).toContain(
          `http_requests_total{method="GET",route="/completion",status="${ending === 'throw' ? '500' : '200'}"} 1\n`,
        )
        expect(text).toContain(
          'http_request_duration_seconds_count{method="GET",route="/completion"} 1\n',
        )
      } finally {
        await app.close()
      }
    },
  )

  it('does not duplicate external metrics for internal requests dispatched from outer handlers', async () => {
    let appInstance: AppInstance
    const app = await createApp(
      createDefinition({
        declarations: [defineMetrics()],
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [
          testRoute('/outer', async () => {
            const internalRes = await appInstance.fetchInternal(
              new Request('http://localhost/inner'),
            )
            const internalJson = await internalRes.json()
            return { fromOuter: true, inner: internalJson }
          }),
          testRoute('/inner', () => ({ fromInner: true })),
        ],
      }),
    )
    appInstance = app

    const externalRes = await app.fetch(new Request('http://localhost/outer'))
    expect(externalRes.status).toBe(200)
    const json = await externalRes.json()
    expect(json).toEqual({ fromOuter: true, inner: { fromInner: true } })

    const metricsRes = await app.fetch(new Request('http://localhost/metrics'))
    const text = await metricsRes.text()
    expect(text).toContain('route="/outer"')
    expect(text).not.toContain('route="/inner"')

    await app.close()
  })

  it('records matched route template rather than /* when middleware aborts with 401', async () => {
    const file = parseApiFilePath('secure.[id].get.ts', '/')!
    const app = await createApp(
      createDefinition({
        declarations: [defineMetrics()],
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [
          {
            routePath: file,
            declaration: route({
              middleware: [
                async (c, next) => {
                  if (!c.req.header('authorization')) {
                    return c.text('Unauthorized', 401)
                  }
                  return next()
                },
              ],
            }).handler(() => ({ secret: true })),
          },
        ],
      }),
    )

    const unauthRes = await app.fetch(new Request('http://localhost/secure/user-42'))
    expect(unauthRes.status).toBe(401)
    await unauthRes.text()

    const metricsRes = await app.fetch(new Request('http://localhost/metrics'))
    const text = await metricsRes.text()
    expect(text).toContain('route="/secure/:id"')
    expect(text).toContain('status="401"')
    expect(text).not.toContain('user-42')

    await app.close()
  })

  it('rejects /metrics requests with 401 when auth fails', async () => {
    const app = await createApp(
      createDefinition({
        declarations: [
          defineMetrics({
            auth: (req) => req.headers.get('x-metrics-key') === 'secret',
          }),
        ],
        services: {
          metrics: createMetricsAssembly(
            defineMetrics({
              auth: (req) => req.headers.get('x-metrics-key') === 'secret',
            }),
          ),
        },
        routes: [],
      }),
    )

    const res1 = await app.fetch(new Request('http://localhost/metrics'))
    expect(res1.status).toBe(401)
    expect(res1.headers.get('cache-control')).toBe('no-store')

    const res2 = await app.fetch(
      new Request('http://localhost/metrics', {
        headers: { 'x-metrics-key': 'secret' },
      }),
    )
    expect(res2.status).toBe(200)

    await app.close()
  })

  it('detects route conflict when an application route collides with the metrics path', async () => {
    const conflictingRoute = testRoute('/metrics', () => ({ conflicting: true }))

    await expect(
      createApp(
        createDefinition({
          declarations: [defineMetrics({ path: '/metrics' })],
          services: {
            metrics: createMetricsAssembly(defineMetrics({ path: '/metrics' })),
          },
          routes: [conflictingRoute],
        }),
      ),
    ).rejects.toThrow(/Route conflict/)
  })

  it('rejects metrics declaration during Cloudflare Workers build code generation', () => {
    const project = createProject()
    try {
      expect(() =>
        generateBuildArtifacts({
          generatedDir: join(project.root, '.build'),
          appEntryPath: join(project.root, 'app.ts'),
          appExports: { exports: ['app', 'metrics'] },
          routes: [],
          apiPrefix: '/api',
          webPrefix: '/',
          target: 'cloudflare',
        }),
      ).toThrow(/Cloudflare Workers target does not support Node Prometheus metrics/)
    } finally {
      project.remove()
    }
  })

  it('records actual running, skipped, successful and failed job execution', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const jobs = defineJobs([
      {
        name: 'sync-task',
        schedule: '0 * * * *',
        handler: async (ctx) => {
          const metrics = (ctx as typeof ctx & { metrics: MetricsService }).metrics
          metrics.counter({ name: 'custom_jobs', help: 'Business job calls' }).inc()
          entered.resolve()
          await release.promise
        },
      },
      {
        name: 'failed-task',
        schedule: '0 * * * *',
        handler: () => {
          throw new Error('job failed')
        },
      },
    ])
    const app = await createApp(
      createDefinition({
        services: {
          metrics: createMetricsAssembly(defineMetrics({ runtime: false })),
          jobs: createNodeJobsAssembly(jobs),
        },
        routes: [],
      }),
    )
    const scrape = async () => (await app.fetch(new Request('http://localhost/metrics'))).text()
    try {
      const active = app.jobs.get('sync-task')!.run()
      await entered.promise
      expect(await scrape()).toContain('jobs_running{job="sync-task"} 1')
      await app.jobs.get('sync-task')!.run()
      expect(await scrape()).toContain('jobs_skipped_total{job="sync-task"} 1')
      release.resolve()
      await active
      await expect(app.jobs.get('failed-task')!.run()).rejects.toThrow('job failed')
      const text = await scrape()
      expect(text).toContain('jobs_running{job="sync-task"} 0')
      expect(text).toContain('jobs_runs_total{job="sync-task",result="success"} 1')
      expect(text).toContain('jobs_runs_total{job="failed-task",result="error"} 1')
      expect(text).toContain('custom_jobs_total 1')
    } finally {
      release.resolve()
      await app.close()
    }
  })

  it('omits process runtime metrics when runtime option is false', async () => {
    const app = await createApp(
      createDefinition({
        declarations: [defineMetrics({ runtime: false })],
        services: {
          metrics: createMetricsAssembly(defineMetrics({ runtime: false })),
        },
        routes: [],
      }),
    )

    const res = await app.fetch(new Request('http://localhost/metrics'))
    expect(res.status).toBe(200)
    const text = await res.text()

    expect(text).not.toContain('process_cpu_user_seconds_total')
    expect(text).not.toContain('nodejs_version_info')

    await app.close()
  })

  it('observes stream body completion and active requests gauge lifecycle', async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

    const app = await createApp(
      createDefinition({
        declarations: [defineMetrics()],
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [
          testRoute('/streaming', () => {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controllerRef = controller
                controller.enqueue(new TextEncoder().encode('chunk1\n'))
              },
            })
            return new Response(stream, {
              headers: { 'Content-Type': 'text/plain' },
            })
          }),
        ],
      }),
    )

    const response = await app.fetch(new Request('http://localhost/streaming'))
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const firstChunk = await reader.read()
    expect(new TextDecoder().decode(firstChunk.value)).toBe('chunk1\n')

    // The scrape itself is active alongside the open streaming response.
    const midMetrics = await app.fetch(new Request('http://localhost/metrics'))
    const midText = await midMetrics.text()
    expect(midText).toContain('http_active_requests 2')

    controllerRef!.close()
    const secondChunk = await reader.read()
    expect(secondChunk.done).toBe(true)

    // Only the scrape remains active after the response completes.
    const endMetrics = await app.fetch(new Request('http://localhost/metrics'))
    const endText = await endMetrics.text()
    expect(endText).toContain('http_active_requests 1')
    expect(endText).toContain('http_requests_total')
    expect(endText).toContain('route="/streaming"')

    await app.close()
  })

  it('isolates application registries between independent app instances', async () => {
    const appA = await createApp(
      createDefinition({
        declarations: [defineMetrics()],
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [],
      }),
    )

    const appB = await createApp(
      createDefinition({
        declarations: [defineMetrics()],
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [],
      }),
    )

    const counterA = appA.metrics.counter({
      name: 'app_a_custom_metric',
      help: 'Metric exclusive to App A',
    })
    counterA.inc()

    const resA = await appA.fetch(new Request('http://localhost/metrics'))
    const textA = await resA.text()
    expect(textA).toContain('app_a_custom_metric_total 1')

    const resB = await appB.fetch(new Request('http://localhost/metrics'))
    const textB = await resB.text()
    expect(textB).not.toContain('app_a_custom_metric')

    await appA.close()
    await appB.close()
  })

  it('normalizes unmatched 404 routes to /* in http_requests_total', async () => {
    const app = await createApp(
      createDefinition({
        declarations: [defineMetrics()],
        services: {
          metrics: createMetricsAssembly(defineMetrics()),
        },
        routes: [],
      }),
    )

    const notFoundRes = await app.fetch(new Request('http://localhost/secret-unmatched-path-12345'))
    expect(notFoundRes.status).toBe(404)
    await notFoundRes.text()

    const metricsRes = await app.fetch(new Request('http://localhost/metrics'))
    const text = await metricsRes.text()
    expect(text).toContain('route="/*"')
    expect(text).toContain('status="404"')
    expect(text).not.toContain('secret-unmatched-path-12345')

    await app.close()
  })
})

it('resolves one metrics factory per application instance of a reusable definition', async () => {
  let calls = 0
  const metrics = defineMetrics((env: { path: string }) => {
    calls++
    return { path: env.path, runtime: false }
  })
  const definition = createDefinition({
    services: { metrics: createMetricsAssembly(metrics) },
    routes: [],
  })
  const first = await createApp(definition, { env: { path: '/first' } })
  const second = await createApp(definition, { env: { path: '/second' } })
  try {
    const response = await second.fetch(new Request('http://localhost/second'))
    await response.text()
    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    expect((await second.fetch(new Request('http://localhost/first'))).status).toBe(404)
  } finally {
    await first.close()
    await second.close()
  }
})

it('labels application-level authentication rejections with the selected route template', async () => {
  const app = await createApp(
    createDefinition({
      app: defineApp({ middleware: [async (ctx) => ctx.text('Unauthorized', 401)] }),
      services: { metrics: createMetricsAssembly(defineMetrics({ runtime: false })) },
      routes: [testRoute('/secure/:id', () => 'private')],
    }),
  )
  try {
    await (await app.fetch(new Request('http://localhost/secure/42'))).text()
    const text = await (await app.fetch(new Request('http://localhost/metrics'))).text()
    expect(text).toContain('route="/secure/:id",status="401"')
  } finally {
    await app.close()
  }
})
