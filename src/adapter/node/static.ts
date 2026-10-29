import { realpathSync } from 'node:fs'

import type { StaticAssets } from '../../http/assets'
import { resolveSafeFilePath, serveFileResponse } from './file-response'

/** Fully resolved build location and public URL mapping. */
interface NodeStaticOptions {
  /** Deployed output directory; a symbolic link is resolved when the handler is created. */
  readonly rootDir: string
  /** Allowed public URLs and file paths relative to rootDir. */
  readonly assets: StaticAssets
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
    const file = await resolveSafeFilePath({
      rootDir: root,
      subPath: entry.path,
      followSymlinks: false,
    })
    if (!file) return null

    return serveFileResponse({
      path: file.path,
      stat: file.stat,
      request,
      defaultCacheControl: entry.hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
  }
}
