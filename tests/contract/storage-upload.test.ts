import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { saveUploadFile } from '../../src/features/storage/local'
import { StorageError } from '../../src/features/storage/types'

describe('saveUploadFile Local Helper Contract', () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sark-upload-test-'))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saves Web File atomically, returning relative path, name, and size', async () => {
    const content = new TextEncoder().encode('Uploaded Document Body')
    const file = new File([content], 'my-invoice.pdf', { type: 'application/pdf' })

    const result = await saveUploadFile(file, {
      dir: tempDir,
    })

    expect(result.name).toBe('my-invoice.pdf')
    expect(result.size).toBe(content.byteLength)

    const savedContent = await readFile(result.path, 'utf-8')
    expect(savedContent).toBe('Uploaded Document Body')
  })

  it('accepts custom safe filename and enforces non-overwrite with file_exists', async () => {
    const file1 = new File(['Version 1'], 'test.txt')
    const file2 = new File(['Version 2'], 'test.txt')

    // First save with custom name
    const result1 = await saveUploadFile(file1, {
      dir: tempDir,
      filename: 'report-2026.txt',
    })
    expect(result1.name).toBe('report-2026.txt')

    // Second save with same name fails atomically with file_exists
    let caught: any
    try {
      await saveUploadFile(file2, {
        dir: tempDir,
        filename: 'report-2026.txt',
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(StorageError)
    expect(caught.code).toBe('file_exists')

    // Original content is unchanged
    const original = await readFile(result1.path, 'utf-8')
    expect(original).toBe('Version 1')
  })

  it('rejects illegal filenames and directory traversal', async () => {
    const file = new File(['Hello'], 'test.txt')

    await expect(
      saveUploadFile(file, { dir: tempDir, filename: '../escaped.txt' }),
    ).rejects.toMatchObject({ code: 'invalid_filename' })

    await expect(
      saveUploadFile(file, { dir: tempDir, filename: 'subdir/test.txt' }),
    ).rejects.toThrow('directory separators')

    await expect(saveUploadFile(file, { dir: tempDir, filename: 'bad\0null.txt' })).rejects.toThrow(
      'null bytes',
    )
  })

  it('accepts a leaf name beginning with dots', async () => {
    const result = await saveUploadFile(new File(['draft'], '..draft.txt'), { dir: tempDir })
    expect(await readFile(result.path, 'utf8')).toBe('draft')
  })

  it('cleans up temporary file when maxSizeBytes is exceeded', async () => {
    const largeData = new Uint8Array(1024 * 10) // 10 KB
    const file = new File([largeData], 'large.bin')

    let caught: any
    try {
      await saveUploadFile(file, {
        dir: tempDir,
        filename: 'large.bin',
        maxSizeBytes: 1024, // 1 KB limit
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(StorageError)
    expect(caught.message).toContain('maximum size limit')

    // Ensure no partial or temporary files remained
    const files = await readdir(tempDir)
    expect(files.includes('large.bin')).toBe(false)
    expect(files.some((f) => f.startsWith('.tmp.'))).toBe(false)
  })

  it('cleans up temporary file when operation is aborted via signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('User cancelled upload'))

    const file = new File(['Some data'], 'cancelled.bin')

    let caught: any
    try {
      await saveUploadFile(file, {
        dir: tempDir,
        filename: 'cancelled.bin',
        signal: controller.signal,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    const files = await readdir(tempDir)
    expect(files.includes('cancelled.bin')).toBe(false)
    expect(files.some((f) => f.startsWith('.tmp.'))).toBe(false)
  })
})
