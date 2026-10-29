/**
 * Core Node.js filesystem response utility supporting conditional requests, Range, and HEAD.
 *
 * @module
 */

import { createReadStream, type Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

import { getMimeType } from 'hono/utils/mime'

import { matchesETag } from '../../http/etag'

/** Options controlling safe path resolution against an allowed directory root. */
export interface ResolveSafePathOptions {
  /** Canonical root directory. */
  rootDir: string
  /** Decoded relative subpath requested by the client. */
  subPath: string
  /** Whether symbolic links pointing inside rootDir are permitted; defaults to false. */
  followSymlinks?: boolean
}

/**
 * Resolves and verifies that a relative subpath stays strictly inside rootDir.
 *
 * @param options - Directory boundary, subpath, and symlink policy.
 * @returns Resolved absolute path and stat info, or null if missing, invalid, or escaping root.
 */
export async function resolveSafeFilePath(
  options: ResolveSafePathOptions,
): Promise<{ path: string; stat: Stats } | null> {
  const { rootDir, subPath, followSymlinks = false } = options
  if (subPath.includes('\0') || subPath.split(/[/\\]/).includes('..')) return null
  const absolute = resolve(rootDir, `.${sep}${subPath}`)
  const rel = relative(rootDir, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null

  try {
    const real = await realpath(absolute)
    if (!followSymlinks && real !== absolute) return null
    // If followSymlinks is allowed, ensure the target realpath is still within rootDir
    if (followSymlinks) {
      const realRel = relative(rootDir, real)
      if (!realRel || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        return null
      }
    }
    const info = await stat(real)
    return info.isFile() ? { path: real, stat: info } : null
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
    ) {
      return null
    }
    throw error
  }
}

/** Options for generating an HTTP Response for a resolved file. */
export interface ServeFileOptions {
  /** Validated absolute file path. */
  path: string
  /** File stat metadata. */
  stat: Stats
  /** Client HTTP request. */
  request: Request
  /** Default Cache-Control header if not overridden. */
  defaultCacheControl?: string
  /** Additional custom headers to apply to the response. */
  customHeaders?: Record<string, string>
}

/**
 * Builds an HTTP Response for a local file, handling conditional validators, single-range, and HEAD.
 *
 * @param options - Path, stat metadata, client request, and header configuration.
 * @returns Complete HTTP Response ready for delivery.
 */
export function serveFileResponse(options: ServeFileOptions): Response {
  const { path, stat: info, request, defaultCacheControl = 'no-cache', customHeaders } = options
  const fileEtag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
  const modified = new Date(info.mtimeMs).toUTCString()
  const mime = getMimeType(path) ?? 'application/octet-stream'

  const headers = new Headers({
    'content-type': mime,
    'cache-control': defaultCacheControl,
    etag: fileEtag,
    'last-modified': modified,
    'accept-ranges': 'bytes',
  })

  if (customHeaders) {
    for (const [key, val] of Object.entries(customHeaders)) {
      headers.set(key, val)
    }
  }

  const etag = headers.get('etag')!
  const lastModifiedTime = Date.parse(headers.get('last-modified')!)

  // Strong comparison never matches a weak filesystem validator.
  const ifMatch = request.headers.get('if-match')
  if (ifMatch !== null && !matchesETag(ifMatch, etag, false)) {
    return new Response(null, { status: 412, headers })
  }
  const unmodifiedSince = request.headers.get('if-unmodified-since')
  if (ifMatch === null && unmodifiedSince && Date.parse(unmodifiedSince) < lastModifiedTime) {
    return new Response(null, { status: 412, headers })
  }

  // Preconditions: If-None-Match
  const noneMatch = request.headers.get('if-none-match')
  if (noneMatch !== null) {
    if (matchesETag(noneMatch, etag, true)) {
      return new Response(null, { status: 304, headers })
    }
  } else {
    // If-Modified-Since
    const since = request.headers.get('if-modified-since')
    if (since && Date.parse(since) >= lastModifiedTime) {
      return new Response(null, { status: 304, headers })
    }
  }

  // Range and If-Range (RFC 9110 §13.1.5: If-Range requires strong comparison; weak ETags never match)
  let start = 0
  let end = info.size - 1
  let status = 200
  const range = request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  const cleanIfRange = ifRange?.trim()
  const parsedIfRangeDate = cleanIfRange ? Date.parse(cleanIfRange) : Number.NaN
  const isHttpDate =
    cleanIfRange !== undefined &&
    !cleanIfRange.startsWith('W/') &&
    !cleanIfRange.startsWith('"') &&
    !Number.isNaN(parsedIfRangeDate)
  const rangeAllowed =
    ifRange === null ||
    (isHttpDate && parsedIfRangeDate === lastModifiedTime) ||
    (!etag.startsWith('W/') && cleanIfRange === etag)

  if (range && rangeAllowed && request.method === 'GET') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]))
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      ) {
        headers.set('content-range', `bytes */${info.size}`)
        return new Response(null, { status: 416, headers })
      }
      status = 206
      headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
    }
  }

  headers.set('content-length', String(info.size === 0 ? 0 : end - start + 1))
  if (request.method === 'HEAD' || info.size === 0) {
    return new Response(null, { status, headers })
  }

  const stream = createReadStream(path, { start, end, signal: request.signal })
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
}
