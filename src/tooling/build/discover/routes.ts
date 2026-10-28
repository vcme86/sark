/**
 * Filesystem API route and middleware discovery, precedence ordering, and collision detection.
 *
 * @module
 */

import {
  compareRoutes,
  parseApiFilePath,
  type ParsedRoutePath,
  tokenizePath,
} from '../../../http/path'
import { scanRouteFiles } from './files'
import { parseModule } from './module'

/** Middleware source file and the directory scope it belongs to. */
interface DiscoveredMiddlewareFile {
  /** Absolute file path on the host filesystem. */
  readonly filePath: string
  /** Path relative to the scanned API directory. */
  readonly relativePath: string
  /** Normalized scope key (e.g. `""` for root, `"users"`, `"(admin)/users"`). */
  readonly scopeKey: string
  /** Scope hierarchy segments. */
  readonly scopeSegments: readonly string[]
  /** Whether the middleware module exports a named `scope` configuration. */
  readonly hasScope: boolean
  /** Whether the middleware module exports a default middleware handler. */
  readonly hasDefault: boolean
}

/** API route source file, parsed URL, and ancestor middleware chain. */
export interface DiscoveredRouteFile {
  /** Absolute file path on the host filesystem. */
  readonly filePath: string
  /** Path relative to the scanned API directory. */
  readonly relativePath: string
  /** Parsed URL routing metadata and HTTP method constraints. */
  readonly routePath: ParsedRoutePath
  /** Ancestor middleware ordered from the API root to the closest scope. */
  readonly ancestorMiddlewares: readonly DiscoveredMiddlewareFile[]
}

function inspectMiddlewareExports(filePath: string): { hasScope: boolean; hasDefault: boolean } {
  let hasScope = false
  let hasDefault = false

  for (const node of parseModule(filePath).body) {
    if (node.type === 'ExportDefaultDeclaration') {
      hasDefault = true
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.exportKind === 'type') continue
      if (node.declaration) {
        if (node.declaration.type === 'VariableDeclaration') {
          for (const decl of node.declaration.declarations) {
            if (decl.id.type === 'Identifier' && decl.id.name === 'scope') {
              hasScope = true
            }
          }
        }
      } else if (node.specifiers) {
        for (const spec of node.specifiers) {
          if (spec.type === 'ExportSpecifier' && spec.exportKind === 'type') continue
          const name =
            spec.exported?.type === 'Identifier' ? spec.exported.name : spec.exported?.value
          if (name === 'scope') hasScope = true
          if (name === 'default') hasDefault = true
        }
      }
    }
  }
  return { hasScope, hasDefault }
}

function parseMiddlewareFile(relativePath: string): {
  scopeKey: string
  scopeSegments: string[]
} | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')
  const tokens = tokenizePath(normalized)
  if (tokens.length < 2) return null

  const ext = tokens[tokens.length - 1].toLowerCase()
  if (!['ts', 'js', 'tsx', 'jsx'].includes(ext)) return null

  const penultimate = tokens[tokens.length - 2]
  if (penultimate !== '_middleware') return null

  const scopeSegments = tokens.slice(0, tokens.length - 2)
  return { scopeKey: scopeSegments.join('/'), scopeSegments }
}

function getRouteAncestorScopeKeys(relativePath: string): string[] {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')
  const tokens = tokenizePath(normalized)
  if (tokens.length < 2) return ['']

  // Drop the extension and method suffix; each remaining prefix identifies an ancestor scope.
  const pathTokens = tokens.slice(0, tokens.length - 2)
  if (pathTokens.at(-1) === 'index') pathTokens.pop()
  const keys: string[] = ['']
  for (let i = 1; i <= pathTokens.length; i++) {
    keys.push(pathTokens.slice(0, i).join('/'))
  }
  return keys
}

/**
 * Traverses an API directory to discover routes and directory middleware, rejecting collisions.
 *
 * Discovery behavior:
 * 1. Discover `_middleware` modules using directory or dotted scope paths.
 * 2. Reject duplicate middleware declarations for the same logical scope.
 * 3. Identify endpoint files and order their ancestor middleware chains from root to leaf.
 * 4. Sort routes by static segments, then parameters, then wildcards.
 * 5. Reject route collisions sharing the same path shape and method.
 *
 * @param apiDir - Root directory containing API route files.
 * @param apiPrefix - Resolved URL prefix applied to all discovered routes.
 * @returns Sorted list of discovered route files with linked ancestor middlewares.
 * @throws {Error} If route or middleware collisions are detected.
 */
export function discoverApiRoutes(apiDir: string, apiPrefix: string): DiscoveredRouteFile[] {
  const rawFiles = scanRouteFiles(apiDir)

  // 1. Discover and validate middleware files
  const middlewaresByScope = new Map<string, DiscoveredMiddlewareFile>()
  const routeCandidates: Array<{
    fullPath: string
    rel: string
    parsed: ParsedRoutePath
  }> = []

  for (const { fullPath, rel } of rawFiles) {
    const mw = parseMiddlewareFile(rel)
    if (mw) {
      const existing = middlewaresByScope.get(mw.scopeKey)
      if (existing) {
        throw new Error(
          `Middleware conflict detected: duplicate middleware for scope "${mw.scopeKey}" between "${existing.relativePath}" and "${rel}".`,
        )
      }
      const { hasScope, hasDefault } = inspectMiddlewareExports(fullPath)
      middlewaresByScope.set(mw.scopeKey, {
        filePath: fullPath,
        relativePath: rel,
        scopeKey: mw.scopeKey,
        scopeSegments: mw.scopeSegments,
        hasScope,
        hasDefault,
      })
      continue
    }

    // Dotted and directory paths use the same private-segment convention.
    if (tokenizePath(rel).some((token) => token.startsWith('_'))) continue

    const parsed = parseApiFilePath(rel, apiPrefix)
    if (parsed) {
      routeCandidates.push({ fullPath, rel, parsed })
    }
  }

  // 2. Pair routes with their ancestor middlewares
  const collected: DiscoveredRouteFile[] = []
  for (const { fullPath, rel, parsed } of routeCandidates) {
    const ancestorMiddlewares: DiscoveredMiddlewareFile[] = []
    for (const key of getRouteAncestorScopeKeys(rel)) {
      const mw = middlewaresByScope.get(key)
      if (mw) {
        ancestorMiddlewares.push(mw)
      }
    }

    collected.push({
      filePath: fullPath,
      relativePath: rel,
      routePath: parsed,
      ancestorMiddlewares,
    })
  }

  // 3. Sort candidate routes according to specification
  collected.sort((a, b) => compareRoutes(a.routePath, b.routePath))

  // 4. Conflict detection: same path shape with same specific method
  const seen = new Map<string, DiscoveredRouteFile>()
  for (const item of collected) {
    const key = item.routePath.shapeKey
    const existing = seen.get(key)
    if (existing) {
      throw new Error(
        `Route conflict detected: duplicate handler for ${key} between "${existing.relativePath}" and "${item.relativePath}".`,
      )
    }
    seen.set(key, item)
  }

  return collected
}
