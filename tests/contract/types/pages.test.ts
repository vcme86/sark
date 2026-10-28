import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { generateProject } from '../../../src/tooling/build/project'
import { createProject } from '../../helpers/project'
import { checkTypes } from '../../helpers/typecheck'

const projectRoot = process.cwd()

describe('Page Type Contracts (P3)', () => {
  it('compiles generated server, resource and browser imports with quotes in source paths', () => {
    const project = createProject()
    const appEntry = `config/app's "entry".ts`
    const apiDir = `api's "routes"`
    const webDir = `web's "pages"`
    try {
      project.write(
        appEntry,
        `import { defineApp } from '@olivaw/sark/server'
import { defineNodeRuntime } from '@olivaw/sark/server/node'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { definePage } from '@olivaw/sark/page'
export const app = defineApp({})
export const runtime = defineNodeRuntime({})
export const database = defineDatabase({ filename: ':memory:' })
export const page = definePage({})`,
      )
      project.write(`${apiDir}/_middleware.ts`, 'export const scope = { csrf: false }')
      project.write(
        `${apiDir}/answer.get.ts`,
        `import { route } from '@olivaw/sark/server'
export default route().handler(ctx => ctx.var.db.$client.prepare('select 42 as answer').get())`,
      )
      project.write(
        `${webDir}/index.tsx`,
        'export default function Page() { return <h1>Home</h1> }',
      )
      project.write(`${webDir}/_root.tsx`, 'export default function Root() { return <html /> }')
      project.write(`${webDir}/_layout.tsx`, 'export default function Layout() { return <main /> }')
      project.write(
        `${webDir}/_error.tsx`,
        'export default function ErrorPage() { return <p>Error</p> }',
      )
      project.write(`${webDir}/_middleware.ts`, 'export const scope = { csrf: false }')
      generateProject(project.root, { appEntry, apiDir, webDir })
      project.write(
        'tsconfig.json',
        JSON.stringify({
          extends: resolve(projectRoot, 'tsconfig.json'),
          include: ['**/*.ts', '**/*.tsx', '.build/**/*.ts', '.build/**/*.tsx'],
          exclude: [],
        }),
      )
      const result = checkTypes(project.root)
      expect(result.status, result.output).toBe(0)
    } finally {
      project.remove()
    }
  })

  it('compiles generated entries with concrete loader parameters and component props', () => {
    const project = createProject()
    try {
      project.write('app.ts', '')
      project.write('app/index.tsx', 'export default function Page() { return <h1>Home</h1> }')
      project.write(
        'api/posts.[id].get.ts',
        `import { route, z } from '@olivaw/sark/server'
export default route().validate({ params: z.object({ id: z.string() }) })
  .handler((_ctx, { params }) => ({ title: params.id }))`,
      )
      project.write(
        'app/posts/[id].tsx',
        `import type { LoaderArgs, ShouldRevalidateArgs } from '@olivaw/sark/page'
export function shouldRevalidate({ currentParams, nextParams }: ShouldRevalidateArgs<{ id: string }>) {
  return currentParams.id !== nextParams.id
}
export async function loader({ client, params }: LoaderArgs<{ id: string }>) {
  const post = await client.get('/posts/:id', { params })
  const title: string = post.title
  if (false) {
    // @ts-expect-error Registered endpoint requires path parameters.
    await client.get('/posts/:id')
    // @ts-expect-error A wildcard array is not a single path parameter.
    await client.get('/posts/:id', { params: { id: ['one'] } })
  }
  return { title }
}
export default function Page({ data }: { data: { title: string } }) {
  return <h1>{data.title}</h1>
}`,
      )
      generateProject(project.root)
      project.write(
        'tsconfig.json',
        JSON.stringify({
          extends: resolve(projectRoot, 'tsconfig.json'),
          include: ['.build/**/*.ts', '.build/**/*.tsx', 'app/**/*.tsx'],
          exclude: [],
        }),
      )
      const result = checkTypes(project.root)
      expect(result.status, result.output).toBe(0)
    } finally {
      project.remove()
    }
  })

  it.each(['node', 'cloudflare'] as const)(
    'registers a separated Api type in real %s generated entries',
    (target) => {
      const project = createProject()
      try {
        project.write('app.ts', '')
        project.write(
          'contracts.ts',
          `export type Api = {
  '/articles/:id': { GET: { input: { params: { id: string } }; output: { title: string } } }
}`,
        )
        project.write(
          'app/[id].tsx',
          `import type { LoaderArgs } from '@olivaw/sark/page'
export async function loader({ client, params }: LoaderArgs<{ id: string }>) {
  const article = await client.get('/articles/:id', { params })
  const title: string = article.title
  if (false) {
    // @ts-expect-error The registered external endpoint requires parameters.
    await client.get('/articles/:id')
    // @ts-expect-error Undeclared endpoints are not accepted.
    await client.get('/missing')
  }
  return { title }
}
export default function Page({ data }: { data: { title: string } }) { return <h1>{data.title}</h1> }`,
        )
        generateProject(project.root, { target, apiDir: false, apiTypes: './contracts' })
        project.write(
          'tsconfig.json',
          JSON.stringify({
            extends: resolve(projectRoot, 'tsconfig.json'),
            include: ['.build/**/*.ts', '.build/**/*.tsx', 'app/**/*.tsx'],
            exclude: [],
          }),
        )
        const result = checkTypes(project.root)
        expect(result.status, result.output).toBe(0)
        project.write(
          'api/local.get.ts',
          "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'local')",
        )
        expect(() => generateProject(project.root, { apiTypes: './contracts' })).toThrow(
          'apiTypes cannot be combined',
        )
      } finally {
        project.remove()
      }
    },
  )

  it('checks page transport and loader/action declarations without generating an application', () => {
    const project = createProject()
    try {
      project.write(
        'transport.ts',
        String.raw`
import { definePage } from '@olivaw/sark/page'
definePage({ api: { serverUrl: 'https://api.example.test', browserUrl: '/api' } })
// @ts-expect-error Remote transport requires serverUrl.
definePage({ api: { browserUrl: '/api' } })
`,
      )
      project.write(
        'loaders.ts',
        String.raw`
import type { ActionArgs, LoaderArgs } from '@olivaw/sark/page'
import type { HttpClient } from '@olivaw/sark/http'

type PostApi = {
  '/posts/:id': {
    GET: {
      input: { params: { id: string } }
      output: { id: string; title: string }
    }
    POST: {
      input: { params: { id: string }; json: { content: string } }
      output: { success: boolean }
    }
  }
}

export async function loader(args: LoaderArgs<{ id: string }, PostApi>) {
  const post = await args.client.get('/posts/:id', {
    params: { id: args.params.id },
  })
  return { post }
}

export async function action(args: ActionArgs<{ id: string }, PostApi>) {
  const content = args.formData.get('content') as string
  const result = await args.client.post('/posts/:id', {
    params: { id: args.params.id },
    json: { content },
  })
  return { result }
}
`,
      )
      project.write(
        'parameters.ts',
        String.raw`
import type { LoaderArgs } from '@olivaw/sark/page'

type PostApi = {
  '/posts/:id': {
    GET: {
      input: { params: { id: string } }
      output: { id: string }
    }
  }
}

export async function loader(args: LoaderArgs<{ slug: string[] }, PostApi>) {
  // Type error: slug is string[], but id: string is required
  // @ts-expect-error Type string[] is not assignable to type string
  return args.client.get('/posts/:id', { params: { id: args.params.slug } })
}
`,
      )
      project.write(
        'tsconfig.json',
        JSON.stringify({
          extends: resolve(projectRoot, 'tsconfig.json'),
          include: ['*.ts'],
        }),
      )
      const result = checkTypes(project.root)
      expect(result.status, result.output).toBe(0)
    } finally {
      project.remove()
    }
  })
})
