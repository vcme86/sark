/**
 * Core storage contracts, options, and error representation.
 *
 * @module
 */

/** Valid payload types for storage write operations. */
export type FileBody = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>

/** Options supplied when writing a file to storage. */
export interface PutOptions {
  /** MIME type assigned to the stored file. */
  contentType?: string
  /** Stream length in bytes; required for R2 stream adaptation, not an upload size limit. */
  contentLength?: number
  /** Whether to overwrite an existing object; defaults to false. */
  overwrite?: boolean
  /**
   * Cancels supported upload work and cleans up temporary state; cannot undo a committed object.
   * R2 cancellation applies to stream transfer and pre-call checks, not the native request.
   */
  signal?: AbortSignal
}

/** Stored file metadata. */
export interface StoredFile {
  /** Storage key identifying the file within its bucket or root. */
  readonly key: string
  /** Full object size in bytes, including when only a range is read. */
  readonly size: number
  /** Stored content type. */
  readonly contentType: string
  /** Backend entity tag, which may be weak, if available. */
  readonly etag?: string
  /** Last modification timestamp, if available. */
  readonly lastModified?: Date
  /** URL constructed from publicUrl, if configured; does not grant public access. */
  readonly url?: string
}

/** Stored file including its readable content stream. */
export interface StoredContent extends StoredFile {
  /** Content byte stream managed by the caller. */
  readonly body: ReadableStream<Uint8Array>
}

/** Options supplied when reading a file from storage. */
export interface GetOptions {
  /** Byte range to retrieve. */
  range?: {
    offset: number
    length?: number
  }
  /** Strong If-Match condition; weak tags do not match, and '*' checks existence. */
  ifMatch?: string
  /** Weak If-None-Match comparison, including '*' for any existing object. */
  ifNoneMatch?: string
  /** Cancellation signal for the read operation. */
  signal?: AbortSignal
}

/** Options for signing a direct object upload or download URL. */
export interface PresignOptions {
  /** Target HTTP method to execute against the presigned URL. */
  operation: 'put' | 'get'
  /** Target object key. */
  key: string
  /** Lifetime in seconds; must not exceed configured maximum. */
  expiresIn?: number
  /** Content-Type requirement to sign when uploading. */
  contentType?: string
}

/** Result of a successful presign operation. */
export interface PresignResult {
  /** Fully qualified URL to send the direct request to. */
  readonly url: string
  /** Required HTTP method. */
  readonly method: 'PUT' | 'GET'
  /** Headers that must be included with the direct request. */
  readonly headers: Record<string, string>
  /** Signature expiration on the Unix epoch, in seconds; credentials may expire earlier. */
  readonly expiresAt: number
}

/** Common file store interface implemented by all storage backends. */
export interface FileStore {
  /**
   * Writes content to storage.
   *
   * @param key - Relative normalized key identifying the object.
   * @param body - Binary payload or byte stream.
   * @param options - Write settings including overwrite control and cancellation.
   * @returns Stored file metadata.
   * @throws {StorageError} If the key already exists and overwrite is false (`file_exists`),
   *   or on write failure.
   */
  put(key: string, body: FileBody, options?: PutOptions): Promise<StoredFile>

  /**
   * Retrieves an object's metadata and content stream.
   *
   * @param key - Relative normalized key identifying the object.
   * @param options - Read constraints including byte range and preconditions.
   * @returns Stored file content, or null if the key does not exist.
   * @throws {StorageError} On unsatisfied precondition or unsatisfiable range.
   */
  get(key: string, options?: GetOptions): Promise<StoredContent | null>

  /**
   * Retrieves an object's metadata without reading its content.
   *
   * @param key - Relative normalized key identifying the object.
   * @returns Stored file metadata, or null if the key does not exist.
   */
  head(key: string): Promise<StoredFile | null>

  /**
   * Removes an object from storage. Missing objects resolve successfully.
   *
   * @param key - Relative normalized key identifying the object.
   */
  delete(key: string): Promise<void>
}

/** Classification codes for storage failures. */
export type StorageErrorCode =
  | 'file_exists'
  | 'precondition_failed'
  | 'not_modified'
  | 'range_not_satisfiable'
  | 'unsupported_operation'
  | 'storage_error'

/** Standard error raised by storage implementations. */
export class StorageError extends Error {
  readonly code: StorageErrorCode

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StorageError'
    this.code = code
  }
}

/** Validates and normalizes an object key to prevent directory traversal and null bytes. */
export function validateStorageKey(key: string): string {
  if (!key || typeof key !== 'string') {
    throw new StorageError('storage_error', 'Storage key must be a non-empty string.')
  }
  if (key.includes('\0')) {
    throw new StorageError('storage_error', 'Storage key must not contain null bytes.')
  }
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new StorageError('storage_error', 'Storage key must not start with a path separator.')
  }
  if (key.endsWith('/') || key.endsWith('\\')) {
    throw new StorageError('storage_error', 'Storage key must not end with a path separator.')
  }
  const segments = key.split(/[/\\]/)
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new StorageError(
        'storage_error',
        'Storage key must not contain relative dot segments (.. or .).',
      )
    }
    if (segment === '') {
      throw new StorageError('storage_error', 'Storage key must not contain empty path segments.')
    }
  }
  return segments.join('/')
}

/** Constructs a public URL by encoding key segments onto a base URL. */
export function buildPublicUrl(publicUrl: string | undefined, key: string): string | undefined {
  if (!publicUrl) return undefined
  const cleanBase = publicUrl.replace(/\/+$/, '')
  return `${cleanBase}/${encodeStorageKey(key)}`
}

/** Checks byte-range arithmetic before passing it to a storage backend. */
export function validateStorageRange(range: NonNullable<GetOptions['range']>): void {
  const { offset, length } = range
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (length !== undefined &&
      (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset + length)))
  ) {
    throw new StorageError(
      'range_not_satisfiable',
      'Range offset and length must describe a finite, non-negative byte range.',
    )
  }
}

/** Encodes an object path using RFC 3986, preserving only its segment separators. */
export function encodeStorageKey(key: string): string {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')
}
