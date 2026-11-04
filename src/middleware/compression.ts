import type { compress } from 'hono/compress'

/** HTTP compression options delegated to Hono. */
export type CompressionOptions = NonNullable<Parameters<typeof compress>[0]>

/** Enabled compression settings with Sark's encoding resolved. */
export type ResolvedCompressionOptions = CompressionOptions & {
  readonly encoding: NonNullable<CompressionOptions['encoding']>
}

/** Sark's compression default; thresholds and filters remain owned by Hono. */
const DEFAULT_COMPRESSION_OPTIONS = { encoding: 'gzip' as const }

/**
 * Resolves compression at a Node runtime or explicit middleware boundary.
 *
 * @param input - Optional options, true for defaults, or false to disable compression.
 * @returns Disabled compression or options with a resolved encoding.
 */
export function resolveCompression(
  input?: CompressionOptions | boolean,
): false | ResolvedCompressionOptions {
  if (input === false) return false
  const options = typeof input === 'object' ? input : {}
  return {
    ...options,
    encoding:
      options.encoding === undefined ? DEFAULT_COMPRESSION_OPTIONS.encoding : options.encoding,
  }
}
