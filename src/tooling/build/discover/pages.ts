/**
 * Filesystem page, layout, error boundary, and scope middleware discovery.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { parseSync } from 'vite'

import {
  compareRoutes,
  parseApiFilePath,
  type RouteSegment,
  tokenizePath,
} from '../../../web/http/path'

/** Parsed page route URL and collision signature. */
export interface ParsedPageRoutePath {
  /** Relative URL path (e.g. `/`, `/posts/:id`, `/posts/*`). */
  readonly urlPath: string
  /** Normalized path signature used for route collision detection (e.g. `/posts/:param`). */
  readonly shapeKey: string
  /** Parsed path segments for route ordering and parameter matching. */
  readonly segments: readonly RouteSegment[]
  /** Extracted single-parameter names. */
  readonly paramNames: readonly string[]
  /** Extracted wildcard parameter name, if any. */
  readonly wildcardName?: string
}

/** Discovered AST export flags for a page or layout module. */
export interface PageExportFlags {
  readonly hasDefault: boolean
  readonly hasLoader: boolean
  readonly hasAction: boolean
  readonly hasMeta: boolean
  readonly hasCache: boolean
  readonly hasShouldRevalidate: boolean
  readonly hasScope?: boolean
}

/** Discovered layout source file. */
export interface DiscoveredLayoutFile {
  readonly filePath: string
  readonly relativePath: string
  readonly scopeKey: string
  readonly closestError?: DiscoveredErrorFile
  readonly exports: Omit<PageExportFlags, 'hasAction'>
}

/** Discovered error presentation source file. */
export interface DiscoveredErrorFile {
  readonly filePath: string
  readonly relativePath: string
  readonly scopeKey: string
  readonly exports: { readonly hasDefault: boolean }
}

/** Discovered root document source file (`_root.tsx`). */
export interface DiscoveredRootFile {
  readonly filePath: string
  readonly relativePath: string
  readonly exports: { readonly hasDefault: boolean }
}

/** Discovered page scope middleware file (`_middleware.ts/.js`). */
export interface DiscoveredPageMiddlewareFile {
  readonly filePath: string
  readonly relativePath: string
  readonly scopeKey: string
  readonly scopeSegments: readonly string[]
  readonly exports: { readonly hasDefault: boolean; readonly hasScope: boolean }
}

/** Complete scope metadata linking ancestor layouts, errors, and middlewares. */
export interface DiscoveredPageScope {
  readonly scopeKey: string
  readonly layout?: DiscoveredLayoutFile
  readonly error?: DiscoveredErrorFile
  readonly middleware?: DiscoveredPageMiddlewareFile
}

/** Discovered page route source file. */
export interface DiscoveredPageFile {
  readonly filePath: string
  readonly relativePath: string
  readonly routePath: ParsedPageRoutePath
  /** Unique scope identifier based on logical path (e.g. `""` for index, `"posts/[id]"`). */
  readonly scopeId: string
  /** Existing layout, error, or middleware scopes from the website root to this page's scope. */
  readonly ancestorScopes: readonly DiscoveredPageScope[]
  /** Chain of ancestor layout files from outer to inner. */
  readonly layoutChain: readonly DiscoveredLayoutFile[]
  /** Nearest ancestor error module, or undefined for the default error component. */
  readonly closestError?: DiscoveredErrorFile
  /** Chain of ancestor page middleware files from outer to inner. */
  readonly middlewareChain: readonly DiscoveredPageMiddlewareFile[]
  /** Inspected module exports. */
  readonly exports: PageExportFlags
}

/** Overall page discovery outcome. */
export interface DiscoveredPageTree {
  readonly rootDocument?: DiscoveredRootFile
  readonly pages: readonly DiscoveredPageFile[]
  readonly layouts: ReadonlyMap<string, DiscoveredLayoutFile>
  readonly errors: ReadonlyMap<string, DiscoveredErrorFile>
  readonly middlewares: ReadonlyMap<string, DiscoveredPageMiddlewareFile>
}

function inspectModuleExports(filePath: string): PageExportFlags {
  const sourceText = readFileSync(filePath, 'utf-8')
  try {
    const parseResult = parseSync(filePath, sourceText)
    if (parseResult.errors.length > 0) {
      throw new Error(parseResult.errors.map((error) => error.message).join('\n'))
    }
    let hasDefault = false
    let hasLoader = false
    let hasAction = false
    let hasMeta = false
    let hasCache = false
    let hasShouldRevalidate = false
    let hasScope = false

    for (const node of parseResult.program.body) {
      if (node.type === 'ExportDefaultDeclaration') {
        hasDefault = true
      } else if (node.type === 'ExportNamedDeclaration') {
        if (node.exportKind === 'type') continue
        if (node.declaration) {
          if (
            node.declaration.type === 'FunctionDeclaration' ||
            node.declaration.type === 'ClassDeclaration'
          ) {
            const name = node.declaration.id?.name
            if (name === 'loader') hasLoader = true
            if (name === 'action') hasAction = true
            if (name === 'meta') hasMeta = true
            if (name === 'cache') hasCache = true
            if (name === 'shouldRevalidate') hasShouldRevalidate = true
            if (name === 'scope') hasScope = true
          } else if (node.declaration.type === 'VariableDeclaration') {
            for (const decl of node.declaration.declarations) {
              if (decl.id.type === 'Identifier') {
                const name = decl.id.name
                if (name === 'loader') hasLoader = true
                if (name === 'action') hasAction = true
                if (name === 'meta') hasMeta = true
                if (name === 'cache') hasCache = true
                if (name === 'shouldRevalidate') hasShouldRevalidate = true
                if (name === 'scope') hasScope = true
              }
            }
          }
        } else if (node.specifiers) {
          for (const spec of node.specifiers) {
            if (spec.exportKind === 'type') continue
            const name =
              spec.exported?.type === 'Identifier' ? spec.exported.name : spec.exported?.value
            if (name === 'default') hasDefault = true
            if (name === 'loader') hasLoader = true
            if (name === 'action') hasAction = true
            if (name === 'meta') hasMeta = true
            if (name === 'cache') hasCache = true
            if (name === 'shouldRevalidate') hasShouldRevalidate = true
            if (name === 'scope') hasScope = true
          }
        }
      }
    }
    return {
      hasDefault,
      hasLoader,
      hasAction,
      hasMeta,
      hasCache,
      hasShouldRevalidate,
      ...(hasScope ? { hasScope } : {}),
    }
  } catch (error) {
    throw new Error(`Failed to parse page module "${filePath}".`, { cause: error })
  }
}

function parseReservedPageFile(relativePath: string): {
  type: 'root' | 'layout' | 'error' | 'middleware'
  scopeKey: string
  scopeSegments: string[]
} | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')
  const tokens = tokenizePath(normalized)
  if (tokens.length < 2) return null

  const ext = tokens[tokens.length - 1].toLowerCase()
  const name = tokens[tokens.length - 2]

  if (name === '_root') {
    if (!['tsx', 'jsx'].includes(ext)) return null
    if (tokens.length === 2) {
      return { type: 'root', scopeKey: '', scopeSegments: [] }
    }
    return null
  }

  if (name === '_layout') {
    if (!['tsx', 'jsx'].includes(ext)) return null
    const scopeSegments = tokens.slice(0, tokens.length - 2)
    return { type: 'layout', scopeKey: scopeSegments.join('/'), scopeSegments }
  }

  if (name === '_error') {
    if (!['tsx', 'jsx'].includes(ext)) return null
    const scopeSegments = tokens.slice(0, tokens.length - 2)
    return { type: 'error', scopeKey: scopeSegments.join('/'), scopeSegments }
  }

  if (name === '_middleware') {
    if (!['ts', 'js'].includes(ext)) return null
    const scopeSegments = tokens.slice(0, tokens.length - 2)
    return { type: 'middleware', scopeKey: scopeSegments.join('/'), scopeSegments }
  }

  return null
}

function parsePageRoutePath(relativePath: string, webPrefix: string): ParsedPageRoutePath {
  const parsed = parseApiFilePath(relativePath.replace(/\.(tsx|jsx)$/i, '.get.ts'), webPrefix)!
  const segments = parsed.segments.map((segment) =>
    segment.kind === 'wildcard' ? { ...segment, raw: '*' } : segment,
  )
  const wildcardIndex = segments.findIndex((segment) => segment.kind === 'wildcard')
  if (wildcardIndex !== -1 && wildcardIndex !== segments.length - 1) {
    throw new Error(`Wildcard must be the terminal URL segment in route "${relativePath}".`)
  }
  const prefix = webPrefix === '/' ? '' : webPrefix
  const urlPath =
    prefix + (segments.map((segment) => '/' + segment.raw).join('') || (prefix ? '' : '/'))
  const shapeKey =
    prefix +
    (segments
      .map((segment) => '/' + (segment.kind === 'param' ? ':param' : segment.raw.toLowerCase()))
      .join('') || (prefix ? '' : '/'))
  return {
    urlPath,
    shapeKey,
    segments,
    paramNames: segments
      .filter((segment) => segment.kind !== 'static')
      .map((segment) => segment.name!),
    wildcardName: segments.find((segment) => segment.kind === 'wildcard')?.name,
  }
}

/**
 * Orders page routes by static segments, then parameter segments, then wildcard segments.
 *
 * @param a - First candidate page route.
 * @param b - Second candidate page route.
 * @returns A negative number when a precedes b, positive when b precedes a, or 0 when equal.
 */
export function comparePageRoutes(a: ParsedPageRoutePath, b: ParsedPageRoutePath): number {
  return compareRoutes({ urlPath: a.urlPath, method: 'GET' }, { urlPath: b.urlPath, method: 'GET' })
}

/**
 * Discovers page components, layouts, error boundaries, and scope middlewares from the filesystem.
 *
 * Discovery rules:
 * 1. Scans `webDir` for `.tsx` and `.jsx` files (and `.ts`/`.js` for `_middleware`).
 * 2. Identifies reserved files: `_root.tsx/.jsx`, `_layout.tsx/.jsx`, `_error.tsx/.jsx`, `_middleware.ts/.js`.
 * 3. Rejects scope conflicts for duplicate layouts, errors, or middlewares.
 * 4. Parses module exports using AST inspection to discover loaders, actions, meta, cache, and revalidation hooks.
 * 5. Orders pages deterministically (static segments > parameters > wildcards).
 * 6. Rejects route collisions sharing identical path shapes.
 *
 * @param webDir - Resolved root directory containing page files, or `false` to disable discovery.
 * @param webPrefix - Resolved website URL prefix supplied by the engineering configuration.
 * @returns Fully resolved page tree with scope hierarchies and linked ancestor layouts and error boundaries.
 * @throws {Error} If page, layout, error, or middleware collisions or invalid exports are detected.
 */
export function discoverPages(webDir: string | false, webPrefix: string): DiscoveredPageTree {
  if (webDir === false || !existsSync(webDir)) {
    return {
      pages: [],
      layouts: new Map(),
      errors: new Map(),
      middlewares: new Map(),
    }
  }

  const rawFiles: Array<{ fullPath: string; rel: string }> = []

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir)
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const fullPath = join(currentDir, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        if (entry.startsWith('_')) continue
        walk(fullPath)
      } else if (stat.isFile()) {
        if (entry.includes('.test.') || entry.includes('.spec.') || entry.endsWith('.d.ts')) {
          continue
        }
        rawFiles.push({ fullPath, rel: relative(webDir as string, fullPath) })
      }
    }
  }

  walk(webDir)

  let rootDocument: DiscoveredRootFile | undefined
  const layoutsByScope = new Map<string, DiscoveredLayoutFile>()
  const errorsByScope = new Map<string, DiscoveredErrorFile>()
  const middlewaresByScope = new Map<string, DiscoveredPageMiddlewareFile>()
  const pageCandidates: Array<{ fullPath: string; rel: string }> = []

  for (const { fullPath, rel } of rawFiles) {
    const reserved = parseReservedPageFile(rel)
    if (reserved) {
      const exports = inspectModuleExports(fullPath)
      if (!exports.hasDefault && reserved.type !== 'middleware') {
        throw new Error(`Reserved module "${rel}" must export a default React component.`)
      }

      if (reserved.type === 'root') {
        if (rootDocument) {
          throw new Error(
            `Root document conflict detected: duplicate root document between "${rootDocument.relativePath}" and "${rel}".`,
          )
        }
        if (exports.hasLoader || exports.hasAction) {
          throw new Error(`Root document "${rel}" cannot export data hooks (loader, action).`)
        }
        rootDocument = {
          filePath: fullPath,
          relativePath: rel,
          exports: { hasDefault: exports.hasDefault },
        }
      } else if (reserved.type === 'layout') {
        const existing = layoutsByScope.get(reserved.scopeKey)
        if (existing) {
          throw new Error(
            `Layout conflict detected: duplicate layout for scope "${reserved.scopeKey}" between "${existing.relativePath}" and "${rel}".`,
          )
        }
        if (exports.hasAction) {
          throw new Error(
            `Layout module "${rel}" cannot export "action". Actions are only permitted on page routes.`,
          )
        }
        layoutsByScope.set(reserved.scopeKey, {
          filePath: fullPath,
          relativePath: rel,
          scopeKey: reserved.scopeKey,
          exports: {
            hasDefault: exports.hasDefault,
            hasLoader: exports.hasLoader,
            hasMeta: exports.hasMeta,
            hasCache: exports.hasCache,
            hasShouldRevalidate: exports.hasShouldRevalidate,
          },
        })
      } else if (reserved.type === 'error') {
        const existing = errorsByScope.get(reserved.scopeKey)
        if (existing) {
          throw new Error(
            `Error boundary conflict detected: duplicate error boundary for scope "${reserved.scopeKey}" between "${existing.relativePath}" and "${rel}".`,
          )
        }
        errorsByScope.set(reserved.scopeKey, {
          filePath: fullPath,
          relativePath: rel,
          scopeKey: reserved.scopeKey,
          exports: { hasDefault: exports.hasDefault },
        })
      } else if (reserved.type === 'middleware') {
        if (!exports.hasDefault && !exports.hasScope) {
          throw new Error(`Page middleware "${rel}" must export scope or a default middleware.`)
        }
        const existing = middlewaresByScope.get(reserved.scopeKey)
        if (existing) {
          throw new Error(
            `Page middleware conflict detected: duplicate middleware for scope "${reserved.scopeKey}" between "${existing.relativePath}" and "${rel}".`,
          )
        }
        middlewaresByScope.set(reserved.scopeKey, {
          filePath: fullPath,
          relativePath: rel,
          scopeKey: reserved.scopeKey,
          scopeSegments: reserved.scopeSegments,
          exports: { hasDefault: exports.hasDefault, hasScope: Boolean(exports.hasScope) },
        })
      }
      continue
    }

    // Ignore other underscore-prefixed helper files
    const tokens = tokenizePath(rel.replace(/\\/g, '/').replace(/^\.?\//, ''))
    if (tokens.some((t) => t.startsWith('_'))) {
      continue
    }

    // Ordinary pages must be .tsx or .jsx
    const ext = tokens[tokens.length - 1].toLowerCase()
    if (!['tsx', 'jsx'].includes(ext)) {
      continue
    }

    pageCandidates.push({ fullPath, rel })
  }

  // Resolve closest error ancestor for each discovered layout
  for (const [scope, layout] of layoutsByScope) {
    const tokens = layout.scopeKey ? layout.scopeKey.split('/') : []
    for (let i = tokens.length; i >= 0; i--) {
      const key = tokens.slice(0, i).join('/')
      const err = errorsByScope.get(key)
      if (err) {
        layoutsByScope.set(scope, { ...layout, closestError: err })
        break
      }
    }
  }

  const collectedPages: DiscoveredPageFile[] = []

  for (const { fullPath, rel } of pageCandidates) {
    const routePath = parsePageRoutePath(rel, webPrefix)
    const exports = inspectModuleExports(fullPath)
    if (!exports.hasDefault) {
      throw new Error(`Page module "${rel}" must export a default React component.`)
    }

    // Build scope ancestry
    const tokens = tokenizePath(rel.replace(/\\/g, '/').replace(/^\.?\//, ''))
    tokens.pop() // remove extension
    const isIndex = tokens[tokens.length - 1] === 'index'
    const scopeTokens = isIndex ? tokens.slice(0, -1) : tokens
    const scopeId = scopeTokens.join('/')

    const ancestorScopeKeys: string[] = ['']
    for (let i = 1; i <= scopeTokens.length; i++) {
      ancestorScopeKeys.push(scopeTokens.slice(0, i).join('/'))
    }

    const ancestorScopes: DiscoveredPageScope[] = []
    const layoutChain: DiscoveredLayoutFile[] = []
    const middlewareChain: DiscoveredPageMiddlewareFile[] = []

    for (const key of ancestorScopeKeys) {
      const layout = layoutsByScope.get(key)
      const error = errorsByScope.get(key)
      const middleware = middlewaresByScope.get(key)

      if (layout) layoutChain.push(layout)
      if (middleware) middlewareChain.push(middleware)

      if (layout || error || middleware) {
        ancestorScopes.push({ scopeKey: key, layout, error, middleware })
      }
    }

    // Find closest error boundary upwards from leaf scope
    let closestError: DiscoveredErrorFile | undefined
    for (let i = ancestorScopeKeys.length - 1; i >= 0; i--) {
      const err = errorsByScope.get(ancestorScopeKeys[i])
      if (err) {
        closestError = err
        break
      }
    }

    collectedPages.push({
      filePath: fullPath,
      relativePath: rel,
      routePath,
      scopeId,
      ancestorScopes,
      layoutChain,
      closestError,
      middlewareChain,
      exports,
    })
  }

  // Sort pages deterministically
  collectedPages.sort((a, b) => comparePageRoutes(a.routePath, b.routePath))

  // Conflict detection
  const seenPages = new Map<string, DiscoveredPageFile>()
  for (const page of collectedPages) {
    const key = page.routePath.shapeKey
    const existing = seenPages.get(key)
    if (existing) {
      throw new Error(
        `Page conflict detected: duplicate page for "${key}" between "${existing.relativePath}" and "${page.relativePath}".`,
      )
    }
    seenPages.set(key, page)
  }

  return {
    rootDocument,
    pages: collectedPages,
    layouts: layoutsByScope,
    errors: errorsByScope,
    middlewares: middlewaresByScope,
  }
}
