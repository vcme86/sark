import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { mountNodeProbes } from '../../src/adapter/node/probes'
import { defineHealth } from '../../src/entries/node'
import { createApp } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { createHealthAssembly } from '../../src/features/health/assembly'
import { resolveHealthConfig } from '../../src/features/health/declaration'
import { createHealthCheckRunner } from '../../src/features/health/runner'
import type { HealthCheckContext } from '../../src/features/health/types'

describe('health contract', () => {
  it('deduplicates concurrent check executions and caches successful results', async () => {
    let checkRunCount = 0

    const runner = createHealthCheckRunner(
      resolveHealthConfig(
        defineHealth({
          readiness: {
            db: async () => {
              checkRunCount++
              await new Promise((r) => setTimeout(r, 10))
            },
          },
          cache: 50, // 50ms cache
        }),
        undefined,
      ),
      () => ({}),
    )

    // Concurrently trigger 3 check runs
    const [res1, res2, res3] = await Promise.all([
      runner.runReadiness(),
      runner.runReadiness(),
      runner.runReadiness(),
    ])

    expect(res1.ok).toBe(true)
    expect(res2.ok).toBe(true)
    expect(res3.ok).toBe(true)
    // Concurrency deduplication should ensure the check only ran once!
    expect(checkRunCount).toBe(1)

    // Immediate subsequent run should hit cache
    const res4 = await runner.runReadiness()
    expect(res4.ok).toBe(true)
    expect(checkRunCount).toBe(1)

    // Wait for cache to expire
    await new Promise((r) => setTimeout(r, 60))
    const res5 = await runner.runReadiness()
    expect(res5.ok).toBe(true)
    expect(checkRunCount).toBe(2)
  })

  it('times out slow checks and retains in-flight check to prevent stampede', async () => {
    let settled = false
    let runCount = 0

    const runner = createHealthCheckRunner(
      resolveHealthConfig(
        defineHealth({
          readiness: {
            'slow-db': async ({ signal }: HealthCheckContext) => {
              runCount++
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, 80)
                signal.addEventListener('abort', () => {
                  // Signal is aborted, but work takes time to complete
                  setTimeout(() => {
                    settled = true
                    clearTimeout(timer)
                    resolve(undefined)
                  }, 40)
                })
              })
            },
          },
          timeout: 20, // 20ms timeout
        }),
        undefined,
      ),
      () => ({}),
    )

    // First run times out
    const res1 = await runner.runReadiness()
    expect(res1.ok).toBe(false)
    expect(res1.failed).toEqual(['slow-db'])
    expect(runCount).toBe(1)
    expect(settled).toBe(false)

    // Immediate second run should not trigger a new check while previous is still in-flight
    const res2 = await runner.runReadiness()
    expect(res2.ok).toBe(false)
    expect(res2.failed).toEqual(['slow-db'])
    expect(runCount).toBe(1)

    // Wait until background check actually settles
    await new Promise((r) => setTimeout(r, 60))
    expect(settled).toBe(true)

    // Now that in-flight check has settled, next run will start a new one
    await runner.runReadiness()
    expect(runCount).toBe(2)
  })

  it('enforces health.auth independently on probes', async () => {
    const app = await createApp(
      createDefinition({
        health: createHealthAssembly(
          defineHealth({
            auth: (req: Request) => {
              const token = req.headers.get('X-Probe-Secret')
              return token === 'probe-secret-pass'
            },
          }),
        ),
      }),
    )

    const probes = new Hono()
    mountNodeProbes(
      probes,
      app,
      { liveness: '/livez', readiness: '/readyz' },
      app.definition.health?.(undefined, true),
    )

    try {
      // Missing auth -> 401
      const unauthLive = await probes.request('/livez')
      expect(unauthLive.status).toBe(401)
      await unauthLive.text()

      const unauthReady = await probes.request('/readyz')
      expect(unauthReady.status).toBe(401)
      await unauthReady.text()

      // Invalid auth -> 401
      const badLive = await probes.request('/livez', {
        headers: { 'X-Probe-Secret': 'wrong' },
      })
      expect(badLive.status).toBe(401)
      await badLive.text()

      // Valid auth -> 200
      const okLive = await probes.request('/livez', {
        headers: { 'X-Probe-Secret': 'probe-secret-pass' },
      })
      expect(okLive.status).toBe(200)
      await okLive.text()

      const okReady = await probes.request('/readyz', {
        headers: { 'X-Probe-Secret': 'probe-secret-pass' },
      })
      expect(okReady.status).toBe(200)
      await okReady.text()
    } finally {
      await app.close()
    }
  })

  it('returns 503 and lists failed checks on readiness probe failure', async () => {
    const app = await createApp(
      createDefinition({
        health: createHealthAssembly(
          defineHealth({
            readiness: {
              redis: () => {},
              postgres: () => {
                throw new Error('Connection refused')
              },
            },
          }),
        ),
      }),
    )

    const probes = new Hono()
    mountNodeProbes(
      probes,
      app,
      { liveness: '/livez', readiness: '/readyz' },
      app.definition.health?.(undefined, true),
    )

    try {
      // /livez remains 200 (liveness checks process state, not dependency readiness)
      const live = await probes.request('/livez')
      expect(live.status).toBe(200)
      await live.text()

      // /readyz returns 503 and lists failed checks
      const ready = await probes.request('/readyz')
      expect(ready.status).toBe(503)
      const body = (await ready.json()) as { status: string; failed: string[] }
      expect(body).toEqual({
        status: 'unavailable',
        failed: ['postgres'],
      })
    } finally {
      await app.close()
    }
  })

  it('registers in-flight health check work so app.close waits for check to finish before disposing resources', async () => {
    let checkFinished = false
    let resourceDisposed = false

    const app = await createApp(
      createDefinition({
        resources: {
          testDb: {
            target: 'node',
            async createStatic() {
              return {
                value: { query: () => 'ok' },
                dispose: async () => {
                  resourceDisposed = true
                },
              }
            },
          },
        },
        health: createHealthAssembly(
          defineHealth({
            readiness: {
              db: async () => {
                await new Promise((r) => setTimeout(r, 40))
                checkFinished = true
              },
            },
          }),
        ),
      }),
    )

    const probes = new Hono()
    mountNodeProbes(
      probes,
      app,
      { liveness: '/livez', readiness: '/readyz' },
      app.definition.health?.(undefined, true),
    )

    // Start probe request
    const probePromise = Promise.resolve(probes.request('/readyz')).then((response) =>
      response.text(),
    )

    // Start close almost immediately
    await new Promise((r) => setTimeout(r, 10))
    const closePromise = app.close()

    await Promise.all([probePromise, closePromise])

    // Check must have finished before or during disposal
    expect(checkFinished).toBe(true)
    expect(resourceDisposed).toBe(true)
  })
})
