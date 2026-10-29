import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createProject, projectRoot, runProjectCli } from '../helpers/project'
import { checkTypes } from '../helpers/typecheck'

describe('Storage and Assets Project Generation Integration', () => {
  it('discovers named storage and assets declarations, generating types, assembly, and working routes for Node', async () => {
    const project = createProject()
    const uploadsDir = join(project.root, 'uploads')

    try {
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
import { defineStorage } from '@olivaw/sark/storage/local'
import { defineAssets } from '@olivaw/sark/assets/node'

export const app = defineApp({ csrf: false })

export const storage = {
  uploads: defineStorage({ dir: ${JSON.stringify(uploadsDir)} }),
}

export const assets = defineAssets([
  { path: '/static-files', dir: ${JSON.stringify(uploadsDir)} },
])`,
      )

      project.write(
        'api/file.post.ts',
        `import { route } from '@olivaw/sark/server'

export default route().handler(async (c) => {
  const store = c.var.storage.uploads
  const saved = await store.put('message.txt', new TextEncoder().encode('Sark Integration Works!'))
  return {
    key: saved.key,
    size: saved.size,
  }
})`,
      )

      project.write(
        'api/file.get.ts',
        `import { route } from '@olivaw/sark/server'

export default route().handler(async (c) => {
  const store = c.var.storage.uploads
  const item = await store.get('message.txt')
  if (!item) return { found: false }
  const text = await new Response(item.body).text()
  return {
    found: true,
    content: text,
  }
})`,
      )

      // Run CLI generate and assert successful exit code
      const cliResult = runProjectCli(project.root, [
        'build',
        '--mode',
        'generate',
        '--target',
        'node',
      ])
      expect(cliResult.status).toBe(0)

      // Verify generated .build/app.ts
      const appTs = readFileSync(join(project.root, '.build/app.ts'), 'utf-8')
      expect(appTs).toContain(
        "import { createDefinition, createStorageAssembly } from '@olivaw/sark/runtime/core'",
      )
      expect(appTs).toContain('import { storage } from')
      expect(appTs).toContain('import { assets } from')
      expect(appTs).toContain('storage: createStorageAssembly(storage)')
      expect(appTs).toContain('assetMounts: assets,')
      expect(appTs).not.toContain('createAssetMountHandler')

      // Verify generated .build/resources-types.ts
      const resTypes = readFileSync(join(project.root, '.build/resources-types.ts'), 'utf-8')
      expect(resTypes).toContain(
        'export type Storage = { [K in keyof typeof storage]: InferResource<(typeof storage)[K]> }',
      )
      expect(resTypes).toContain('readonly storage: Storage')

      // Verify generated .build/types.d.ts
      const typesDts = readFileSync(join(project.root, '.build/types.d.ts'), 'utf-8')
      expect(typesDts).toContain("export type { Storage } from './resources-types'")

      // Execute real TypeScript compiler check on generated code
      project.write(
        'tsconfig.json',
        JSON.stringify({
          extends: resolve(projectRoot, 'tsconfig.json'),
          include: ['**/*.ts', '.build/**/*.ts'],
        }),
      )
      const typecheckResult = checkTypes(project.root)
      expect(typecheckResult.status, typecheckResult.output).toBe(0)

      // Load assembled app and test execution
      const { definition } = await import(join(project.root, '.build/app.ts'))
      const { createApp } = await import('../../src/entries/server')
      const instance = await createApp(definition)

      try {
        // 1. Post to save file
        const postRes = await instance.fetch(
          new Request('http://localhost/api/file', { method: 'POST' }),
        )
        expect(postRes.status).toBe(200)
        const postJson = await postRes.json()
        expect(postJson.key).toBe('message.txt')
        expect(postJson.size).toBe(23)

        // 2. Get via API route
        const getRes = await instance.fetch(new Request('http://localhost/api/file'))
        expect(getRes.status).toBe(200)
        const getJson = await getRes.json()
        expect(getJson.found).toBe(true)
        expect(getJson.content).toBe('Sark Integration Works!')

        // 3. Direct GET via asset mount
        const assetRes = await instance.fetch(
          new Request('http://localhost/static-files/message.txt'),
        )
        expect(assetRes.status).toBe(200)
        expect(await assetRes.text()).toBe('Sark Integration Works!')
      } finally {
        await instance.close()
      }
    } finally {
      project.remove()
    }
  })

  it('generates working Workers build artifacts with R2 and enforces platform assets boundary', () => {
    const project = createProject()

    try {
      project.write(
        'vite.config.ts',
        `import { sark } from '@olivaw/sark/vite'
export default { plugins: [sark({ target: 'cloudflare' })] }`,
      )

      // 1. Valid Workers project with R2 binding factory
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
import { defineStorage } from '@olivaw/sark/storage/r2'
import type { R2Bucket } from '@cloudflare/workers-types'

declare global {
  interface Env {
    BUCKET: R2Bucket
  }
}

export const app = defineApp({ csrf: false })

export const storage = {
  data: defineStorage<Env>((env) => ({
    binding: env.BUCKET,
  })),
}`,
      )

      project.write(
        'api/ping.get.ts',
        `import { route } from '@olivaw/sark/server'

export default route().handler(() => ({ ok: true }))`,
      )

      const generateResult = runProjectCli(project.root, ['generate'])
      expect(generateResult.status).toBe(0)

      project.write(
        'tsconfig.json',
        JSON.stringify({
          extends: resolve(projectRoot, 'tsconfig.json'),
          include: ['**/*.ts', '.build/**/*.ts'],
        }),
      )
      const typecheckResult = checkTypes(project.root)
      expect(typecheckResult.status, typecheckResult.output).toBe(0)

      // 2. Invalid configuration: attempting to declare node assets on Cloudflare target
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
import { defineAssets } from '@olivaw/sark/assets/node'

export const app = defineApp({ csrf: false })
export const assets = defineAssets([{ path: '/files', dir: './files' }])`,
      )

      const invalidResult = runProjectCli(project.root, ['generate'])
      expect(invalidResult.status).not.toBe(0)
      expect(invalidResult.stderr + invalidResult.stdout).toContain(
        'Cloudflare Workers target does not support Node asset mounts',
      )
    } finally {
      project.remove()
    }
  })
})
