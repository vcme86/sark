/**
 * Local filesystem storage provider and atomic upload helper for Node.js.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { getMimeType } from 'hono/utils/mime'

import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from '../../core/declaration'
import type { ResourceAssembly } from '../../core/resource'
import { matchesETag } from '../../http/etag'
import {
  buildPublicUrl,
  type FileBody,
  type FileStore,
  type GetOptions,
  type PutOptions,
  StorageError,
  type StoredContent,
  type StoredFile,
  validateStorageKey,
  validateStorageRange,
} from './types'

/** Configuration options for local disk storage. */
export interface LocalStorageConfig {
  /** Storage root; relative paths resolve from the Node runtime working directory. */
  dir: string | undefined
  /** Optional public URL prefix used for StoredFile.url construction. */
  publicUrl?: string
  /** Presigning is unsupported on local disk and will throw. */
  presign?: never
}

/** Declaration representing a local storage configuration. */
export interface LocalStorageDeclaration
  extends ResourceAssembly<FileStore>, BaseDeclaration<'storage', LocalStorageConfig> {
  readonly driver: 'local'
}

/** Options supplied to saveUploadFile. */
export interface SaveUploadOptions {
  /** Destination directory; relative paths resolve from the Node runtime working directory. */
  dir: string
  /** Explicit filename to save as; must be a valid single filename segment. */
  filename?: string
  /** Maximum allowed size in bytes; triggers cleanup if exceeded. */
  maxSizeBytes?: number
  /** Cancellation signal for the upload. */
  signal?: AbortSignal
}

/** Result returned by saveUploadFile. */
export interface SavedUploadFile {
  /** Path from the working directory to the saved file; may include parent segments. */
  path: string
  /** Validated filename. */
  name: string
  /** Final written size in bytes. */
  size: number
}

/** Validates that a filename contains only a single leaf segment without separators or traversal. */
export function validateUploadFilename(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new StorageError('storage_error', 'Upload filename must be a non-empty string.')
  }
  if (name.includes('\0')) {
    throw new StorageError('storage_error', 'Upload filename must not contain null bytes.')
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new StorageError(
      'storage_error',
      'Upload filename must not contain directory separators.',
    )
  }
  if (name === '.' || name === '..') {
    throw new StorageError('storage_error', 'Upload filename must not be a relative dot segment.')
  }
  return name
}

/** Converts various FileBody types to a Node.js Readable stream. */
function bodyToReadable(body: FileBody): Readable {
  if (body instanceof Uint8Array) {
    return Readable.from(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
  }
  if (body instanceof ArrayBuffer) {
    return Readable.from(Buffer.from(body))
  }
  if (body instanceof Blob) {
    return Readable.fromWeb(body.stream() as unknown as NodeReadableStream)
  }
  if (body instanceof ReadableStream) {
    return Readable.fromWeb(body as unknown as NodeReadableStream)
  }
  throw new StorageError('storage_error', 'Unsupported file body type.')
}

/** Streams content to a temporary sibling file, tracking written bytes and cleaning up on failure. */
async function atomicWriteToPath(
  targetPath: string,
  source: Readable,
  options: {
    overwrite?: boolean
    maxSizeBytes?: number
    signal?: AbortSignal
  },
): Promise<number> {
  const dir = dirname(targetPath)
  const tempPath = join(dir, `.tmp.${randomUUID()}.${process.pid}`)
  let bytesWritten = 0
  try {
    await mkdir(dir, { recursive: true })
    options.signal?.throwIfAborted()
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.byteLength
        if (options.maxSizeBytes !== undefined && bytesWritten > options.maxSizeBytes) {
          callback(
            new StorageError(
              'storage_error',
              `File exceeds maximum size limit of ${options.maxSizeBytes} bytes.`,
            ),
          )
        } else {
          callback(null, chunk)
        }
      },
    })
    await pipeline(source, counter, createWriteStream(tempPath, { flags: 'wx' }), {
      signal: options.signal,
    })
    options.signal?.throwIfAborted()

    // link() atomically refuses an existing destination; rename() explicitly replaces it.
    if (options.overwrite) {
      await rename(tempPath, targetPath)
    } else {
      await link(tempPath, targetPath)
      await unlink(tempPath)
    }
    return bytesWritten
  } catch (error) {
    source.destroy()
    try {
      await unlink(tempPath)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('storage_error', 'File write and temporary file cleanup failed.', {
          cause: new AggregateError([error, cleanupError], 'Local upload cleanup failed.', {
            cause: error,
          }),
        })
      }
    }
    if (error instanceof StorageError) throw error
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StorageError('file_exists', `File already exists: ${basename(targetPath)}`, {
        cause: error,
      })
    }
    throw new StorageError('storage_error', 'Local file write failed.', { cause: error })
  }
}

/**
 * Saves an uploaded Web File without overwriting an existing file.
 *
 * @param file - Incoming Web File.
 * @param options - Destination directory, custom name, limits, and abort signal.
 * @returns The name, size, and path relative to the working directory; the path may include '..'.
 * @throws {StorageError} If the filename is invalid, the file exists, or writing or cleanup fails.
 */
export async function saveUploadFile(
  file: File,
  options: SaveUploadOptions,
): Promise<SavedUploadFile> {
  if (!file || typeof file.stream !== 'function') {
    throw new StorageError('storage_error', 'Invalid File supplied to saveUploadFile.')
  }
  if (
    options.maxSizeBytes !== undefined &&
    (!Number.isSafeInteger(options.maxSizeBytes) || options.maxSizeBytes < 0)
  ) {
    throw new StorageError('storage_error', 'maxSizeBytes must be a non-negative integer of bytes.')
  }
  const filename = validateUploadFilename(options.filename ?? file.name)
  const root = process.cwd()
  const targetDir = resolve(root, options.dir)
  const targetPath = resolve(targetDir, filename)

  const stream = Readable.fromWeb(file.stream() as unknown as NodeReadableStream)
  const written = await atomicWriteToPath(targetPath, stream, {
    overwrite: false,
    maxSizeBytes: options.maxSizeBytes,
    signal: options.signal,
  })

  return {
    path: relative(root, targetPath),
    name: filename,
    size: written,
  }
}

/** Infers metadata without persisting a second source of truth beside the file. */
function inferLocalContentType(filePath: string): string {
  const raw = getMimeType(filePath) ?? 'application/octet-stream'
  return raw.split(';')[0].trim().toLowerCase()
}

class LocalFileStore implements FileStore {
  private readonly rootDir: string
  private readonly publicUrl?: string

  constructor(dir: string, publicUrl?: string) {
    this.rootDir = resolve(process.cwd(), dir)
    this.publicUrl = publicUrl
  }

  private async resolveKeyTarget(key: string): Promise<{ validKey: string; filePath: string }> {
    const validKey = validateStorageKey(key)
    const filePath = resolve(this.rootDir, `.${sep}${validKey}`)
    const rel = relative(this.rootDir, filePath)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new StorageError('storage_error', 'Resolved key escapes root directory.')
    }

    // The root may be a deployment symlink; child paths must never traverse symlinks.
    const segments = rel.split(sep)
    let current = this.rootDir
    for (const segment of segments) {
      current = join(current, segment)
      try {
        const stats = await lstat(current)
        if (stats.isSymbolicLink()) {
          throw new StorageError(
            'storage_error',
            'Subordinate symbolic links inside storage root are not permitted.',
          )
        }
      } catch (err: any) {
        if (err instanceof StorageError) throw err
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
          // Uncreated intermediate or target path cannot be a symlink
          break
        }
        throw new StorageError('storage_error', 'Failed to inspect file path', { cause: err })
      }
    }

    return { validKey, filePath }
  }

  async put(key: string, body: FileBody, options?: PutOptions): Promise<StoredFile> {
    const { validKey, filePath } = await this.resolveKeyTarget(key)
    const expectedContentType = inferLocalContentType(filePath)

    // Filesystem storage cannot persist MIME metadata independently of the filename.
    if (options?.contentType !== undefined) {
      const inputType = options.contentType.split(';')[0].trim().toLowerCase()
      if (inputType !== expectedContentType) {
        throw new StorageError(
          'unsupported_operation',
          `Local storage determines content type by file extension (${expectedContentType}) and does not support arbitrary custom metadata (${options.contentType}).`,
        )
      }
      // Reject custom parameters since local filesystem storage cannot persist them across reads
      if (options.contentType.includes(';')) {
        throw new StorageError(
          'unsupported_operation',
          `Local storage determines content type by file extension (${expectedContentType}) and does not support arbitrary custom parameters (${options.contentType}).`,
        )
      }
    }

    const stream = bodyToReadable(body)
    const written = await atomicWriteToPath(filePath, stream, {
      overwrite: options?.overwrite ?? false,
      signal: options?.signal,
    })

    const fileStat = await stat(filePath)
    const etag = `W/"${fileStat.size.toString(16)}-${fileStat.mtimeMs.toString(16)}"`

    return {
      key: validKey,
      size: written,
      contentType: expectedContentType,
      etag,
      lastModified: new Date(fileStat.mtimeMs),
      url: buildPublicUrl(this.publicUrl, validKey),
    }
  }

  async head(key: string): Promise<StoredFile | null> {
    const target = await this.resolveKeyTarget(key)

    try {
      const fileStat = await stat(target.filePath)
      if (!fileStat.isFile()) return null
      const etag = `W/"${fileStat.size.toString(16)}-${fileStat.mtimeMs.toString(16)}"`
      const contentType = inferLocalContentType(target.filePath)

      return {
        key: target.validKey,
        size: fileStat.size,
        contentType,
        etag,
        lastModified: new Date(fileStat.mtimeMs),
        url: buildPublicUrl(this.publicUrl, target.validKey),
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null
      throw new StorageError(
        'storage_error',
        `Failed to stat file: ${err?.message ?? String(err)}`,
        { cause: err },
      )
    }
  }

  async get(key: string, options?: GetOptions): Promise<StoredContent | null> {
    options?.signal?.throwIfAborted()
    const target = await this.resolveKeyTarget(key)

    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      fileStat = await stat(target.filePath)
      if (!fileStat.isFile()) return null
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null
      throw new StorageError(
        'storage_error',
        `Failed to stat file: ${err?.message ?? String(err)}`,
        { cause: err },
      )
    }

    const etag = `W/"${fileStat.size.toString(16)}-${fileStat.mtimeMs.toString(16)}"`
    const contentType = inferLocalContentType(target.filePath)

    // HTTP preconditions are evaluated in order: strong If-Match, then weak If-None-Match.
    if (options?.ifMatch && !matchesETag(options.ifMatch, etag, false)) {
      throw new StorageError('precondition_failed', 'If-Match condition failed.')
    }
    if (options?.ifNoneMatch && matchesETag(options.ifNoneMatch, etag, true)) {
      throw new StorageError('not_modified', 'If-None-Match condition matched.')
    }

    let start = 0
    let end = fileStat.size - 1

    if (options?.range) {
      const { offset, length } = options.range
      validateStorageRange(options.range)
      if (offset >= fileStat.size) {
        throw new StorageError(
          'range_not_satisfiable',
          `Requested range offset ${offset} is out of bounds for size ${fileStat.size}.`,
        )
      }
      start = offset
      if (length !== undefined) {
        end = Math.min(fileStat.size - 1, start + length - 1)
      }
    }

    let bodyStream: ReadableStream<Uint8Array>
    if (fileStat.size === 0) {
      bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
    } else {
      const readStream = createReadStream(target.filePath, {
        start,
        end,
        signal: options?.signal,
      })
      bodyStream = Readable.toWeb(readStream) as ReadableStream<Uint8Array>
    }

    return {
      key: target.validKey,
      size: fileStat.size,
      contentType,
      etag,
      lastModified: new Date(fileStat.mtimeMs),
      url: buildPublicUrl(this.publicUrl, target.validKey),
      body: bodyStream,
    }
  }

  async delete(key: string): Promise<void> {
    const { filePath } = await this.resolveKeyTarget(key)
    try {
      await unlink(filePath)
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        return
      }
      throw new StorageError(
        'storage_error',
        `Failed to delete file: ${err?.message ?? String(err)}`,
        { cause: err },
      )
    }
  }
}

/**
 * Declares a local filesystem storage bucket.
 *
 * @param config - Storage root (absolute or relative to the working directory) and optional publicUrl.
 * @returns Storage declaration retaining local provider configuration.
 */
export function defineStorage(config: LocalStorageConfig): LocalStorageDeclaration

/**
 * Declares local storage resolved once during Node application creation.
 *
 * @param factory - Receives the instance environment and returns storage settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineStorage<E = unknown>(
  factory: (env: E) => LocalStorageConfig,
): LocalStorageDeclaration & RequiresEnv<E>

export function defineStorage(
  input: LocalStorageConfig | ((env: any) => LocalStorageConfig),
): LocalStorageDeclaration {
  return {
    kind: 'storage',
    driver: 'local',
    target: 'node',
    value: input,
    isFactory: typeof input === 'function',
    createStatic: async (env) => {
      const config = evaluateDeclaration(input, env, 'storage')
      if (!config.dir || typeof config.dir !== 'string') {
        throw new StorageError('storage_error', 'Local storage requires a non-empty dir property.')
      }
      if ((config as any).presign) {
        throw new StorageError(
          'unsupported_operation',
          'Local filesystem storage does not support presign capabilities.',
        )
      }
      return {
        value: new LocalFileStore(config.dir, config.publicUrl),
      }
    },
  }
}
