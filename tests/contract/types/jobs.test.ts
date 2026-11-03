import { describe, expect, it } from 'vitest'

import { checkGeneratedTypes } from '../../helpers/typecheck'

interface Fixture {
  app: string
  route?: string
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
      ...(fixture.contracts ? { 'contracts.ts': fixture.contracts } : {}),
      ...fixture.files,
    },
    { target: fixture.target, customHost: fixture.customHost },
  )
}

function expectCompiled(result: Awaited<ReturnType<typeof compileFixture>>) {
  expect(result.status, result.output).toBe(0)
}

describe('Jobs generated type contracts (P10)', () => {
  it('supplies declared resources to JobContext and strictly excludes HTTP services', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark/server'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineJobs } from '@olivaw/sark/jobs'
import { defineVisitors } from '@olivaw/sark/visitors'

export const app = defineApp({ hosts: 'localhost' })
export const database = defineDatabase({ filename: ':memory:' })
export const visitors = defineVisitors({ secret: 'my-secret-key-at-least-32-chars!' })

export const jobs = defineJobs([
  {
    name: 'cleanup',
    schedule: '0 3 * * *',
    handler: async (ctx) => {
      // Resource access is typed
      const client = ctx.db.$client

      // @ts-expect-error JobContext must not include HTTP visitor service
      ctx.visitor.ensure()

      // @ts-expect-error JobContext must not include HTTP auth service
      ctx.auth.session

      // Common fields are typed
      const name: string = ctx.name
      const signal: AbortSignal = ctx.signal
    },
  },
])
`,
      }),
    )
  })

  it('enforces Cloudflare onCron and rejects Node options on Cloudflare target', async () => {
    expectCompiled(
      await compileFixture({
        target: 'cloudflare',
        files: {
          'wrangler.jsonc': JSON.stringify({
            name: 'worker-jobs',
            main: '.build/worker.ts',
            compatibility_date: '2026-10-01',
            compatibility_flags: ['nodejs_compat'],
            triggers: { crons: ['0 * * * *'] },
          }),
        },
        app: `import { defineApp } from '@olivaw/sark/server'
import { defineJobs } from '@olivaw/sark/jobs'

export const app = defineApp({ hosts: 'localhost' })
export const jobs = defineJobs([
  {
    name: 'cf-task',
    onCron: '0 * * * *',
    handler: async (ctx) => {
      const name: string = ctx.name
      const signal: AbortSignal = ctx.signal

      // @ts-expect-error HTTP visitor is not in JobContext
      ctx.visitor

      // @ts-expect-error onCron cannot be paired with schedule
      ctx.schedule
    },
  },
])
`,
      }),
    )
  })
})
