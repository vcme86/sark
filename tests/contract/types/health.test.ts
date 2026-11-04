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

describe('Health generated type contracts (P10)', () => {
  it('supplies declared resources to HealthCheckContext and strictly excludes HTTP services', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineHealth } from '@olivaw/sark/node'
import { defineVisitors } from '@olivaw/sark/visitors'

export const app = defineApp({ hosts: 'localhost' })
export const database = defineDatabase({ filename: ':memory:' })
export const visitors = defineVisitors({ secret: 'my-secret-key-at-least-32-chars!' })

export const health = defineHealth({
  readiness: {
    db: async (ctx) => {
      // Resource access is typed
      const memory: boolean = ctx.db.$client.memory

      // @ts-expect-error HealthCheckContext must not include HTTP visitor service
      ctx.visitor.ensure()

      // @ts-expect-error HealthCheckContext must not include HTTP auth service
      ctx.auth.session

      // Common fields are typed
      const signal: AbortSignal = ctx.signal
      return memory
    },
  },
})
`,
      }),
    )
  })
})
