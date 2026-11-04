import { describe, expect, it } from 'vitest'

import { checkGeneratedTypes } from '../../helpers/typecheck'

interface Fixture {
  app: string
  route?: string
  files?: Record<string, string>
  target?: 'node' | 'cloudflare'
  customHost?: boolean
}

function compileFixture(fixture: Fixture) {
  return checkGeneratedTypes(
    {
      'app.ts': fixture.app,
      ...(fixture.route ? { 'api/test.get.ts': fixture.route } : {}),
      ...fixture.files,
    },
    { target: fixture.target, customHost: fixture.customHost },
  )
}

function expectCompiled(result: Awaited<ReturnType<typeof compileFixture>>) {
  expect(result.status, result.output).toBe(0)
}

describe('Visitors generated type contracts (P7)', () => {
  it('registers RequestVisitor on ctx.var.visitor when visitors is exported', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark'
import { defineVisitors } from '@olivaw/sark/visitors'

export const app = defineApp({ hosts: 'localhost' })
export const visitors = defineVisitors({ secret: 'my-secret-key-at-least-32-chars!' })
`,
        route: `import { route } from '@olivaw/sark'

export default route().handler(async (ctx) => {
  const visitor = ctx.var.visitor
  const id: string | null = visitor.id
  const ensured: string = await visitor.ensure()
  await visitor.clear()

  // @ts-expect-error visitor has no nonexistentMethod
  visitor.nonexistentMethod()

  return { id, ensured }
})
`,
      }),
    )
  })

  it('does not register ctx.var.visitor when visitors capability is omitted', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark'

export const app = defineApp({ hosts: 'localhost' })
`,
        route: `import { route } from '@olivaw/sark'

export default route().handler((ctx) => {
  // @ts-expect-error visitor is not registered when omitted
  const visitor = ctx.var.visitor
  return { ok: true }
})
`,
      }),
    )
  })

  it.each([true, false])(
    'validates Cloudflare Env matching visitor factory requirements (compatible=%s)',
    async (compatible) => {
      const result = await compileFixture({
        target: 'cloudflare',
        app: `import { defineApp } from '@olivaw/sark'
import { defineVisitors } from '@olivaw/sark/visitors'

interface CloudflareEnv {
  VISITOR_SECRET: string
}

export const app = defineApp({ hosts: 'localhost' })
export const visitors = defineVisitors((env: CloudflareEnv) => ({
  secret: env.VISITOR_SECRET,
}))
`,
        route: `import { route } from '@olivaw/sark'

export default route().handler(async (ctx) => {
  const id: string | null = ctx.var.visitor.id
  return { id }
})
`,
        files: {
          'worker-configuration.d.ts': `declare global { interface Env { ${
            compatible ? 'VISITOR_SECRET' : 'OTHER_SECRET'
          }: string } }
export {}`,
        },
      })

      if (compatible) {
        expect(result.status, result.output).toBe(0)
      } else {
        expect(result.status).not.toBe(0)
        expect(result.output).toContain('.build/worker.ts')
        expect(result.output).toContain("Property 'VISITOR_SECRET' is missing in type 'Env'")
      }
    },
  )
})
