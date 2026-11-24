import { once } from 'node:events'
import { createServer } from 'node:http'

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import postgres from 'postgres'
import { expect, it } from 'vitest'

import {
  createProject,
  projectRoot,
  runProjectCli,
  serverUrl,
  startNodeProject,
} from '../helpers/project'
import { checkTypes } from '../helpers/typecheck'

const databaseUrl = process.env.SARK_TEST_POSTGRES_URL
const endpoint = process.env.SARK_TEST_S3_ENDPOINT
const credentials = {
  accessKeyId: process.env.SARK_TEST_S3_ACCESS_KEY ?? 'sark-test-key',
  secretAccessKey: process.env.SARK_TEST_S3_SECRET_KEY ?? 'sark-test-secret-12345678',
}

it.skipIf(!databaseUrl || !endpoint)(
  'shares data and sessions across Node replicas and drains an accepted request',
  async () => {
    const project = createProject()
    const id = crypto.randomUUID()
    const bucket = `sark-test-${id}`
    const database = postgres(databaseUrl!, { max: 1 })
    const storage = new S3Client({
      endpoint,
      credentials,
      region: 'us-east-1',
      forcePathStyle: true,
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const gate = createServer(async (_request, response) => {
      entered.resolve()
      await release.promise
      response.end()
    })
    const replicas: Awaited<ReturnType<typeof startNodeProject>>[] = []
    let bucketCreated = false

    try {
      await database`create table if not exists sark_p14_deployment (id text primary key, value text not null)`
      await storage.send(new CreateBucketCommand({ Bucket: bucket }))
      bucketCreated = true
      gate.listen(0, '127.0.0.1')
      await once(gate, 'listening')

      project.write(
        'tsconfig.json',
        JSON.stringify({
          extends: projectRoot + '/tsconfig.json',
          include: ['**/*.ts', '**/*.tsx', '.build/**/*'],
        }),
      )
      project.write(
        'vite.config.ts',
        `
import { sark } from '@olivaw/sark/vite'
import react from '@vitejs/plugin-react'

export default { plugins: [react(), sark()] }
`,
      )
      project.write(
        'records.ts',
        `
import { pgTable, text } from 'drizzle-orm/pg-core'
export const records = pgTable('sark_p14_deployment', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
})
`,
      )
      project.write(
        'app.ts',
        `
import { defineAuth } from '@olivaw/sark/auth'
import { defineDatabase } from '@olivaw/sark/db/postgres'
import { defineJobs } from '@olivaw/sark/jobs'
import { defineNodeRuntime } from '@olivaw/sark/node'
import { defineStorage } from '@olivaw/sark/storage/s3'

import { records } from './records'

export const runtime = defineNodeRuntime({ hostname: '127.0.0.1' })
export const auth = defineAuth((env: NodeJS.ProcessEnv) => ({
  secret: env.SESSION_SECRET,
  cookie: { secure: false },
}))
export const database = defineDatabase((env: NodeJS.ProcessEnv) => ({
  url: env.DATABASE_URL,
  schema: { records },
}))
export const storage = {
  files: defineStorage((env: NodeJS.ProcessEnv) => ({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  })),
}
export const jobs = defineJobs((env: NodeJS.ProcessEnv) => env.REPLICA === 'jobs' ? [{
  name: 'record-job',
  schedule: '0 0 31 12 *',
  runOnInit: true,
  async handler({ db }) {
    await db.insert(records).values({ id: 'job:' + env.DEPLOYMENT_ID, value: env.REPLICA! })
  },
}] : [])
`,
      )
      project.write(
        'api/document.post.ts',
        `
import { route, z } from '@olivaw/sark'
import { records } from '../records'

export default route().validate({ json: z.object({ content: z.string() }) })
  .handler(async (c, { json }) => {
    const id = process.env.DEPLOYMENT_ID!
    await c.var.db.insert(records).values({ id, value: json.content })
    await c.var.storage.files.put('document.txt', new Blob([json.content]))
    await c.var.auth.signIn({ sub: id })
    return c.body(null, 204)
  })
`,
      )
      project.write(
        'api/document.get.ts',
        `
import { HttpError, route } from '@olivaw/sark'
import { eq } from 'drizzle-orm'
import { records } from '../records'

export default route().handler(async (c) => {
  const { identity } = c.var.auth
  if (!identity) throw new HttpError(401, 'Sign in required')
  const [row] = await c.var.db.select().from(records).where(eq(records.id, identity.sub))
  const file = await c.var.storage.files.get('document.txt')
  if (!row || !file) throw new HttpError(404, 'Document not found')
  return { replica: process.env.REPLICA, value: row.value, file: await new Response(file.body).text() }
})
`,
      )
      project.write(
        'api/drain.get.ts',
        `
import { route } from '@olivaw/sark'
import { eq } from 'drizzle-orm'
import { records } from '../records'

export default route().handler(async (c) => {
  const response = await fetch(process.env.GATE_URL!, { signal: c.req.raw.signal })
  await response.arrayBuffer()
  const [record] = await c.var.db.select().from(records).where(eq(records.id, process.env.DEPLOYMENT_ID!))
  return { value: record.value }
})
`,
      )
      project.write(
        'app/index.tsx',
        `
import type { LoaderArgs } from '@olivaw/sark/page'

export function loader({ client, signal }: LoaderArgs) {
  return client.get('/document', { init: { signal } })
}

export default function Home({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  return <h1>{data.value} on replica {data.replica}</h1>
}
`,
      )
      const build = runProjectCli(project.root, ['build'])
      expect(build.status, build.stdout + build.stderr).toBe(0)
      const types = checkTypes(project.root)
      expect(types.status, types.output).toBe(0)
      const env = {
        DATABASE_URL: databaseUrl,
        DEPLOYMENT_ID: id,
        GATE_URL: serverUrl(gate),
        SESSION_SECRET: 'replica-deployment-test-key-at-least-32-bytes',
        S3_ENDPOINT: endpoint,
        S3_BUCKET: bucket,
        S3_ACCESS_KEY: credentials.accessKeyId,
        S3_SECRET_KEY: credentials.secretAccessKey,
      }
      const start = async (replica: string) => {
        const process = await startNodeProject(project.root, { ...env, REPLICA: replica })
        replicas.push(process)
        return process
      }
      const first = await start('a')
      const second = await start('b')
      const jobs = () => database`select value from sark_p14_deployment where id = ${'job:' + id}`
      expect(await jobs()).toEqual([])
      await start('jobs')
      await expect.poll(jobs).toEqual([{ value: 'jobs' }])

      const content = 'Written on replica A'
      const created = await fetch(first.origin + '/api/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: first.origin },
        body: JSON.stringify({ content }),
      })
      expect(created.status, await created.text()).toBe(204)
      const cookie = created.headers.getSetCookie()[0].split(';', 1)[0]
      const read = () => fetch(second.origin + '/api/document', { headers: { Cookie: cookie } })
      expect((await fetch(second.origin + '/api/document')).status).toBe(401)
      expect(await (await read()).json()).toEqual({ replica: 'b', value: content, file: content })
      const page = await fetch(second.origin, {
        headers: { Cookie: cookie, Accept: 'text/html' },
      })
      const html = await page.text()
      expect(page.status, html).toBe(200)
      expect(html).toContain('Written on replica A<!-- --> on replica <!-- -->b')

      const pending = fetch(first.origin + '/api/drain').then((response) => response.json())
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('The in-flight request returned before reaching the gate')
          }),
        ])
        const stopped = first.stop()
        await expect
          .poll(async () => {
            try {
              return (await fetch(first.origin + '/readyz')).status === 503
            } catch {
              return true
            }
          })
          .toBe(true)
        expect((await read()).status).toBe(200)
        release.resolve()
        expect(await pending).toEqual({ value: content })
        expect(await stopped).toEqual([0, null])
      } finally {
        release.resolve()
        await pending.catch(() => {})
      }
    } finally {
      release.resolve()
      gate.close()
      try {
        await Promise.all(replicas.map((replica) => replica.stop()))
        if (bucketCreated) {
          await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'document.txt' }))
          await storage.send(new DeleteBucketCommand({ Bucket: bucket }))
        }
      } finally {
        try {
          await database`delete from sark_p14_deployment where id in (${id}, ${'job:' + id})`
        } finally {
          await database.end()
          storage.destroy()
          project.remove()
        }
      }
    }
  },
  45_000,
)
