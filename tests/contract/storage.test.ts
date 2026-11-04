import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { defineStorage as defineLocalStorage } from '../../src/features/storage/local'
import { type FileStore, StorageError } from '../../src/features/storage/types'

describe('Local FileStore', () => {
  let tempDir: string
  let localStore: FileStore

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sark-storage-test-'))
    const localDecl = defineLocalStorage({
      dir: tempDir,
      publicUrl: 'https://local.assets.test',
    })
    const localRes = await localDecl.createStatic!(undefined, {
      signal: new AbortController().signal,
    })
    localStore = localRes.value
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const testBackends = [{ name: 'Local FileStore', getStore: () => localStore }]

  for (const { name, getStore } of testBackends) {
    describe(name, () => {
      it('executes put, head, get, and delete with correct metadata', async () => {
        const store = getStore()
        const key = 'docs/guide.txt'
        const content = new TextEncoder().encode('Hello Sark Storage!')

        // 1. Initial head returns null
        const headInitial = await store.head(key)
        expect(headInitial).toBeNull()

        // 2. Put file
        const stored = await store.put(key, content, {
          contentType: 'text/plain',
        })
        expect(stored.key).toBe(key)
        expect(stored.size).toBe(content.byteLength)
        expect(stored.contentType).toBe('text/plain')
        expect(stored.url).toBeDefined()

        // 3. Head returns metadata
        const head = await store.head(key)
        expect(head).not.toBeNull()
        expect(head!.size).toBe(content.byteLength)
        expect(head!.etag).toBeDefined()

        // 4. Get retrieves full stream
        const retrieved = await store.get(key)
        expect(retrieved).not.toBeNull()
        expect(retrieved!.size).toBe(content.byteLength)
        const reader = retrieved!.body.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        const combined = Buffer.concat(chunks).toString('utf-8')
        expect(combined).toBe('Hello Sark Storage!')

        // 5. Delete is idempotent
        await store.delete(key)
        expect(await store.head(key)).toBeNull()
        expect(await store.get(key)).toBeNull()
        await store.delete(key) // Repeated delete succeeds
      })

      it('enforces atomic non-overwrite by default with code file_exists', async () => {
        const store = getStore()
        const key = 'secure/unique-file.bin'
        const initialData = new Uint8Array([1, 2, 3, 4])
        const duplicateData = new Uint8Array([5, 6, 7, 8])

        // First put succeeds
        await store.put(key, initialData)

        // Second put without overwrite throws file_exists
        let caught: any
        try {
          await store.put(key, duplicateData)
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(StorageError)
        expect(caught.code).toBe('file_exists')

        // Original data remains intact
        const existing = await store.get(key)
        const bytes = await new Response(existing!.body).bytes()
        expect(Array.from(bytes)).toEqual([1, 2, 3, 4])

        // Explicit overwrite: true succeeds
        await store.put(key, duplicateData, { overwrite: true })
        const overwritten = await store.get(key)
        const newBytes = await new Response(overwritten!.body).bytes()
        expect(Array.from(newBytes)).toEqual([5, 6, 7, 8])

        await store.delete(key)
      })

      it('supports single byte range reading and handles out-of-bounds ranges', async () => {
        const store = getStore()
        const key = 'range-test.dat'
        const fullContent = new TextEncoder().encode('0123456789ABCDEF') // 16 bytes
        await store.put(key, fullContent)

        // Read slice [4..7] ("4567")
        const partial = await store.get(key, { range: { offset: 4, length: 4 } })
        expect(partial).not.toBeNull()
        const sliceBytes = await new Response(partial!.body).text()
        expect(sliceBytes).toBe('4567')

        // Out of bounds range offset throws range_not_satisfiable
        let rangeErr: any
        try {
          await store.get(key, { range: { offset: 999 } })
        } catch (err) {
          rangeErr = err
        }
        expect(rangeErr).toBeInstanceOf(StorageError)
        expect(rangeErr.code).toBe('range_not_satisfiable')

        await store.delete(key)
      })

      it('handles conditional reads via ETag matching', async () => {
        const store = getStore()
        const key = 'conditional-file.txt'
        const content = new TextEncoder().encode('Condition check')
        const stored = await store.put(key, content)
        const etag = stored.etag!

        // A weak filesystem validator cannot satisfy a strong If-Match comparison.
        expect(etag).toMatch(/^W\//)
        await expect(store.get(key, { ifMatch: etag })).rejects.toMatchObject({
          code: 'precondition_failed',
        })
        const exists = await store.get(key, { ifMatch: '*' })
        expect(await new Response(exists!.body).text()).toBe('Condition check')

        // If-None-Match with matching ETag returns not_modified
        let notModifiedErr: any
        try {
          await store.get(key, { ifNoneMatch: etag })
        } catch (err) {
          notModifiedErr = err
        }
        expect(notModifiedErr).toBeInstanceOf(StorageError)
        expect(notModifiedErr.code).toBe('not_modified')

        // If-Match with mismatching ETag returns precondition_failed
        let preconditionErr: any
        try {
          await store.get(key, { ifMatch: '"wrong-etag"' })
        } catch (err) {
          preconditionErr = err
        }
        expect(preconditionErr).toBeInstanceOf(StorageError)
        expect(preconditionErr.code).toBe('precondition_failed')

        await store.delete(key)
      })
    })
  }

  describe('Local FileStore specific security & metadata consistency', () => {
    it('treats a missing key below a file as absent rather than a storage outage', async () => {
      await localStore.put('parent.txt', new TextEncoder().encode('parent'))
      expect(await localStore.head('parent.txt/child.txt')).toBeNull()
      expect(await localStore.get('parent.txt/child.txt')).toBeNull()
      await localStore.delete('parent.txt/child.txt')
      await localStore.delete('parent.txt')
    })

    it('infers contentType from file extension and rejects conflicting custom metadata', async () => {
      const keyConflict = 'custom-type.bin'
      const data = new Uint8Array([1, 2, 3])

      // Conflicting custom content type throws unsupported_operation
      await expect(localStore.put(keyConflict, data, { contentType: 'image/png' })).rejects.toThrow(
        'Local storage determines content type by file extension',
      )

      // Consistent content type succeeds
      const keyPng = 'image.png'
      const storedPng = await localStore.put(keyPng, data, { contentType: 'image/png' })
      expect(storedPng.contentType).toBe('image/png')

      const headPng = await localStore.head(keyPng)
      expect(headPng).not.toBeNull()
      expect(headPng!.contentType).toBe('image/png')

      await localStore.delete(keyPng)
      expect(await localStore.head(keyPng)).toBeNull()
    })

    it('rejects writes escaping root directory via child directory symlinks', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'sark-storage-outside-'))
      const { symlink } = await import('node:fs/promises')
      const symlinkPath = join(tempDir, 'escaped-link')

      try {
        await symlink(outsideDir, symlinkPath, 'dir')

        let caughtErr: any
        try {
          await localStore.put('escaped-link/stolen.txt', new Uint8Array([1, 2, 3]))
        } catch (e) {
          caughtErr = e
        }

        expect(caughtErr).toBeInstanceOf(StorageError)
        expect(caughtErr.code).toBe('storage_error')
        expect(caughtErr.message).toContain(
          'Subordinate symbolic links inside storage root are not permitted',
        )
      } finally {
        await rm(outsideDir, { recursive: true, force: true })
      }
    })

    it('does not expose presign method when presign is not configured', async () => {
      expect('presign' in localStore).toBe(false)
    })
  })
})

it('checks all named storage targets before creating any store', async () => {
  const { createStorageAssembly } = await import('../../src/features/storage/assembly')
  const { vi } = await import('vitest')
  const opened = vi.fn()
  const node = defineLocalStorage({ dir: '/unused/preflight' })
  const { defineStorage: defineR2 } = await import('../../src/features/storage/r2')
  const worker = defineR2({ binding: undefined })
  const nodeAssembly = createStorageAssembly({
    first: { ...node, createStatic: opened },
    wrong: worker,
  })
  await expect(
    nodeAssembly.createStatic!(undefined, { signal: new AbortController().signal }),
  ).rejects.toThrow(/wrong.*Node/)
  expect(opened).not.toHaveBeenCalled()
  const workerAssembly = createStorageAssembly({
    first: { ...worker, createForEvent: opened },
    wrong: node,
  })
  await expect(workerAssembly.createForEvent!({})).rejects.toThrow(/wrong.*Cloudflare/)
  expect(opened).not.toHaveBeenCalled()
})
