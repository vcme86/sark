/**
 * Node.js runtime asset directory mounting declaration and request handler.
 *
 * @module
 */

import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { Context } from 'hono'

import type { AssetMountAssembly } from '../../app/definition'
import { HttpError } from '../../http/error'
import { stripTrailingSlashes } from '../../http/url'
import { resolveSafeFilePath, serveFileResponse } from './file-response'

/** A single runtime directory mount configuration. */
export interface AssetMount {
  /** Absolute URL prefix for matching requests (e.g. '/files'). */
  path: string
  /** Directory to expose; relative paths resolve from the Node.js runtime root. */
  dir: string
  /** Custom headers to apply to served files, overriding defaults. */
  headers?: Record<string, string>
  /** Whether to follow child symlinks within the mount root; defaults to false. */
  followSymlinks?: boolean
}

/** Declaration representing runtime directory assets mounts. */
export interface AssetMountDeclaration extends AssetMountAssembly {
  readonly kind: 'assets'
  readonly target: 'node'
  readonly mounts: readonly AssetMount[]
}

/** Validates and standardizes mount definitions. */
export function validateMounts(mounts: readonly AssetMount[]): AssetMount[] {
  if (!Array.isArray(mounts)) {
    throw new Error('defineAssets requires an array of mount configurations.')
  }
  return mounts.map((mount, index) => {
    if (!mount || typeof mount !== 'object') {
      throw new Error(`Asset mount at index ${index} must be an object.`)
    }
    if (!mount.path || typeof mount.path !== 'string' || !mount.path.startsWith('/')) {
      throw new Error(
        `Asset mount at index ${index} path must be an absolute URL prefix starting with "/".`,
      )
    }
    if (!mount.dir || typeof mount.dir !== 'string') {
      throw new Error(`Asset mount at index ${index} dir must be a non-empty string.`)
    }
    return {
      path: stripTrailingSlashes(mount.path) || '/',
      dir: mount.dir,
      headers: mount.headers,
      followSymlinks: mount.followSymlinks ?? false,
    }
  })
}

/**
 * Declares runtime directory mounts for Node.js, separate from build-owned public files.
 *
 * @param mounts - Array of URL prefix to directory mapping configurations.
 * @returns An AssetMountDeclaration to export as `assets`.
 */
export function defineAssets(mounts: AssetMount[]): AssetMountDeclaration {
  const validated = validateMounts(mounts)
  const prefixes = validated.map((m) => m.path)
  return {
    kind: 'assets',
    target: 'node',
    mounts: validated,
    prefixes,
    createHandler(runtimeRoot = process.cwd()) {
      return createAssetMountHandler({ mounts: validated }, runtimeRoot)
    },
  }
}

/** Absolute mount directory with a canonical root cached once the directory exists. */
interface PreparedMount extends AssetMount {
  resolvedRoot?: string
}

/**
 * Creates an HTTP request handler for declared runtime asset mounts.
 *
 * @param declaration - Validated asset mount declaration.
 * @param runtimeRoot - Application execution root directory; defaults to process.cwd().
 * @returns A handler returning a file or rejection response, or null to continue dispatch.
 */
export function createAssetMountHandler(
  declaration: { readonly mounts: readonly AssetMount[] },
  runtimeRoot = process.cwd(),
): (ctx: Context) => Promise<Response | null> {
  const preparedMounts: PreparedMount[] = declaration.mounts.map((mount) => {
    const dirAbs = resolve(runtimeRoot, mount.dir)
    let resolvedRoot: string | undefined
    try {
      resolvedRoot = realpathSync(dirAbs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      ...mount,
      dir: dirAbs,
      resolvedRoot,
    }
  })

  return async (ctx: Context): Promise<Response | null> => {
    const request = ctx.req.raw
    const url = new URL(request.url)
    const rawPathname = url.pathname

    for (const mount of preparedMounts) {
      if (mount.path !== '/' && !rawPathname.startsWith(mount.path)) {
        continue
      }
      // Ensure match is boundary-separated
      let subPathRaw = ''
      if (mount.path === '/') {
        subPathRaw = rawPathname.slice(1)
      } else {
        const remainder = rawPathname.slice(mount.path.length)
        if (remainder !== '' && !remainder.startsWith('/')) {
          continue
        }
        subPathRaw = remainder.startsWith('/') ? remainder.slice(1) : remainder
      }

      // Single URL decode for path semantics
      let decodedSubPath: string
      try {
        decodedSubPath = decodeURIComponent(subPathRaw)
      } catch {
        return new HttpError(404, 'Invalid URL encoding', {
          code: 'not_found',
        }).toResponse()
      }

      // Directories are not listed; let subsequent mounts or the shared 404 handle them.
      if (
        !decodedSubPath ||
        decodedSubPath.endsWith('/') ||
        decodedSubPath.split(/[/\\]/).some((segment) => segment.startsWith('.'))
      ) {
        continue
      }

      if (mount.resolvedRoot === undefined) {
        try {
          mount.resolvedRoot = await realpath(mount.dir)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'ENOTDIR') continue
          throw error
        }
      }

      const file = await resolveSafeFilePath({
        rootDir: mount.resolvedRoot,
        subPath: decodedSubPath,
        followSymlinks: mount.followSymlinks,
      })

      if (!file) {
        continue
      }

      // Only a real file contributes GET/HEAD to the pipeline's method response.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new HttpError(405, `Method ${request.method} Not Allowed on asset mounts`, {
          code: 'method_not_allowed',
          headers: { Allow: 'GET, HEAD' },
        }).toResponse()
      }

      return serveFileResponse({
        path: file.path,
        stat: file.stat,
        request,
        defaultCacheControl: 'no-cache',
        customHeaders: mount.headers,
      })
    }

    return null
  }
}
