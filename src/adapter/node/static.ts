import { createReadStream, realpathSync, type Stats, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

import { getMimeType } from 'hono/utils/mime'

import type { StaticAssets } from '../../web/http/assets'

/** Fully resolved build location and public URL mapping. */
export interface NodeStaticOptions {
  /** Deployed output directory; a symbolic link is resolved when the handler is created. */
  readonly rootDir: string
  /** Allowed public URLs and file paths relative to rootDir. */
  readonly assets: StaticAssets
}

function resolveDecodedPath(rootDir: string, path: string): { path: string; stat: Stats } | null {
  if (path.includes('\0') || path.split(/[/\\]/).includes('..')) return null
  const absolute = resolve(rootDir, `.${sep}${path}`)
  const rel = relative(rootDir, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  try {
    if (realpathSync(absolute) !== absolute) return null
    const stat = statSync(absolute)
    return stat.isFile() ? { path: absolute, stat } : null
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
    )
      return null
    throw error
  }
}

/**
 * Serves mapped public files with cache validators, HEAD, and single-range support.
 * Resolves the deployment root once and rejects paths escaping it or traversing symlinks.
 *
 * @param options - Deployed output directory and completed public file mapping.
 * @returns A request handler returning null for unsupported methods or unmapped/missing files.
 * @throws {Error} If the deployment root cannot be resolved; unexpected file errors propagate.
 */
export function createNodeStaticHandler(
  options: NodeStaticOptions,
): (request: Request) => Promise<Response | null> {
  const root = realpathSync(options.rootDir)
  const base = new URL(options.assets.base, 'http://assets.local/').pathname
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null
    const pathname = new URL(request.url).pathname
    if (!pathname.startsWith(base)) return null
    let key: string
    try {
      key = decodeURIComponent(pathname.slice(base.length))
    } catch {
      return null
    }
    if (!Object.hasOwn(options.assets.files, key)) return null
    const entry = options.assets.files[key]
    const file = resolveDecodedPath(root, '/' + entry.path)
    if (!file) return null
    const { path, stat } = file
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
    const modified = new Date(stat.mtimeMs).toUTCString()
    const mime = getMimeType(path) ?? 'application/octet-stream'
    const headers = new Headers({
      'content-type': mime,
      'cache-control': entry.hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
      'last-modified': modified,
      'accept-ranges': 'bytes',
    })
    const noneMatch = request.headers.get('if-none-match')
    if (noneMatch !== null) {
      if (
        noneMatch.trim() === '*' ||
        noneMatch
          .split(',')
          .some((value) => value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))
      ) {
        return new Response(null, { status: 304, headers })
      }
    } else {
      const since = request.headers.get('if-modified-since')
      if (since && Date.parse(since) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
        return new Response(null, { status: 304, headers })
      }
    }
    let start = 0
    let end = stat.size - 1
    let status = 200
    const range = request.headers.get('range')
    const ifRange = request.headers.get('if-range')
    const rangeAllowed =
      !ifRange ||
      (!ifRange.startsWith('W/') && Date.parse(ifRange) >= Math.floor(stat.mtimeMs / 1000) * 1000)
    if (range && rangeAllowed && request.method === 'GET') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= stat.size
        ) {
          headers.set('content-range', `bytes */${stat.size}`)
          return new Response(null, { status: 416, headers })
        }
        status = 206
        headers.set('content-range', `bytes ${start}-${end}/${stat.size}`)
      }
    }
    headers.set('content-length', String(stat.size === 0 ? 0 : end - start + 1))
    if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status, headers })
    const stream = createReadStream(path, { start, end, signal: request.signal })
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
  }
}
