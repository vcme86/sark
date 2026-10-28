/**
 * File route parsing, route precedence, and URL path normalization.
 *
 * @module
 */

import { TrieRouter } from 'hono/router/trie-router'

import { canonicalPathname, normalizeUrlPath } from './url'

export interface ParsedRoutePath {
  /** Hono route path including the API prefix (e.g. `/api/users/:id`). */
  readonly urlPath: string
  /** Client route template with named wildcard substitutions (e.g. `/api/files/*path`). */
  readonly clientPath: string
  /** Normalized path signature used for route collision detection. */
  readonly shapeKey: string
  /** Uppercase HTTP method (e.g. `GET`, `POST`, `ALL`). */
  readonly method: string
  /** Parsed path segments. */
  readonly segments: RouteSegment[]
  /** Indicates whether the route handles Server-Sent Events. */
  readonly isSse: boolean
  /** Indicates whether the route handles WebSocket connections. */
  readonly isWs: boolean
}

/** Classification of a route path token. */
type SegmentKind = 'static' | 'param' | 'wildcard'

/** Individual tokenized segment within a route path. */
export interface RouteSegment {
  /** Structural kind of the segment. */
  readonly kind: SegmentKind
  /** Hono path token: static text, a named parameter, or a named catch-all pattern. */
  readonly raw: string
  /** Extracted parameter name if `kind` is `'param'` or `'wildcard'`. */
  readonly name?: string
}

/** Compares API and page paths independently of parameter names and metadata formats. */
export function routeShape(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment === '*' || (segment.startsWith(':') && segment.includes('{.+}'))) return '*'
      return segment.startsWith(':') ? ':' : segment.toLowerCase()
    })
    .join('/')
}

const KNOWN_METHODS = new Set([
  'get',
  'query',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'all',
  'ws',
  'sse',
])

/**
 * Splits paths at `/` and `.`, preserving bracketed expressions.
 *
 * @param pathStr - Path using directory or dot-separated segments.
 * @returns Segments with separators removed and bracketed expressions intact.
 */
export function tokenizePath(pathStr: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inBracket = false
  for (let i = 0; i < pathStr.length; i++) {
    const ch = pathStr[i]
    if (ch === '[') {
      inBracket = true
      current += ch
    } else if (ch === ']') {
      inBracket = false
      current += ch
    } else if (!inBracket && (ch === '.' || ch === '/')) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

/**
 * Converts an API file name into a route path, method, and collision signature.
 *
 * File conventions:
 * - Dot and directory separators create URL segments; groups and a terminal index are omitted.
 * - [name] creates a parameter, [...name] a wildcard, and [.] a literal dot.
 * - The method suffix selects the HTTP method; sse and ws use GET with separate flags.
 *
 * @param relativePath - Source file path relative to apiDir.
 * @param apiPrefix - Resolved URL prefix for the route.
 * @returns Route metadata, or null when the extension or method suffix is not recognized.
 */
export function parseApiFilePath(relativePath: string, apiPrefix: string): ParsedRoutePath | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')
  const tokens = tokenizePath(normalized)
  if (tokens.length < 2) return null

  // The last token is the file extension (ts, js, tsx, jsx)
  const ext = tokens[tokens.length - 1].toLowerCase()
  if (!['ts', 'js', 'tsx', 'jsx'].includes(ext)) {
    return null
  }

  // The penultimate token is the HTTP method / type
  const methodToken = tokens[tokens.length - 2].toLowerCase()
  if (!KNOWN_METHODS.has(methodToken)) return null

  const isWs = methodToken === 'ws'
  const isSse = methodToken === 'sse'
  const method = isWs ? 'GET' : isSse ? 'GET' : methodToken.toUpperCase()

  const pathTokens = tokens.slice(0, tokens.length - 2)
  if (pathTokens.at(-1) === 'index') pathTokens.pop()
  const segments: RouteSegment[] = []
  const shapeTokens: string[] = []

  for (const token of pathTokens) {
    if (token.startsWith('(') && token.endsWith(')')) {
      continue
    }

    if (token.startsWith('[...') && token.endsWith(']')) {
      const name = token.slice(4, -1)
      segments.push({
        kind: 'wildcard',
        raw: `:${name}{.+}?`,
        name,
      })
      shapeTokens.push('*')
    } else if (token.startsWith('[') && token.endsWith(']')) {
      const inner = token.slice(1, -1)
      if (inner === '.') {
        segments.push({ kind: 'static', raw: '.' })
        shapeTokens.push('.')
      } else {
        segments.push({
          kind: 'param',
          raw: `:${inner}`,
          name: inner,
        })
        shapeTokens.push(':__param__')
      }
    } else {
      const resolved = token.replace(/\[\.\]/g, '.')
      segments.push({ kind: 'static', raw: resolved })
      shapeTokens.push(resolved.toLowerCase())
    }
  }

  let pathStr = ''
  for (const s of segments) {
    pathStr += `/${s.raw}`
  }

  const prefix = apiPrefix === '/' ? '' : apiPrefix
  const finalPath = prefix + (pathStr || (prefix ? '' : '/'))
  const clientPath =
    prefix +
    (segments.map((s) => `/${s.kind === 'wildcard' ? `*${s.name}` : s.raw}`).join('') ||
      (prefix ? '' : '/'))
  const shapeKey = `${method}:${prefix}/${shapeTokens.join('/')}`

  return {
    urlPath: finalPath,
    clientPath,
    shapeKey,
    method,
    segments,
    isSse,
    isWs,
  }
}

/**
 * Orders routes by static, parameter, then wildcard segments, with ALL as a method fallback.
 *
 * @param a - First candidate route.
 * @param b - Second candidate route.
 * @returns A negative value when a precedes b, positive when b precedes a, or zero for equal priority.
 */
export function compareRoutes(
  a: Pick<ParsedRoutePath, 'urlPath' | 'method'>,
  b: Pick<ParsedRoutePath, 'urlPath' | 'method'>,
): number {
  const segmentsA = a.urlPath.split('/').filter(Boolean)
  const segmentsB = b.urlPath.split('/').filter(Boolean)
  const maxLen = Math.max(segmentsA.length, segmentsB.length)
  for (let i = 0; i < maxLen; i++) {
    const segA = segmentsA[i]
    const segB = segmentsB[i]
    if (!segA) return -1
    if (!segB) return 1

    const rankA = segmentRank(segA)
    const rankB = segmentRank(segB)

    if (rankA !== rankB) {
      return rankA - rankB
    }
  }

  if (a.method !== 'ALL' && b.method === 'ALL') return -1
  if (a.method === 'ALL' && b.method !== 'ALL') return 1

  return 0
}

function segmentRank(segment: string): number {
  return segment === '*' || segment.includes('{.+}') ? 2 : segment.startsWith(':') ? 1 : 0
}

export interface RouteCanonicalizer {
  /**
   * Resolves static segment casing while preserving parameter and wildcard values.
   *
   * @param pathname - Incoming URL pathname.
   * @param method - Incoming HTTP method; HEAD uses the GET route candidates.
   * @returns A canonical path when casing changes, or null when no change or match is found.
   */
  findCanonical(pathname: string, method: string): string | null
}

/**
 * Uses Hono matching to select method-aware candidates for case normalization.
 *
 * @param routes - Routes in matching priority order; dynamic candidates retain this order.
 * @returns A canonicalizer preserving the case of parameter and wildcard values.
 */
export function createRouteCanonicalizer(
  routes: Array<{ readonly routePath: ParsedRoutePath }>,
): RouteCanonicalizer {
  const router = new TrieRouter<string[]>()
  const pathIndex = '__SARK_CANONICAL_PATH__'
  for (const entry of routes) {
    const { urlPath, method } = entry.routePath
    const segments = urlPath.split('/')
    router.add(method, urlPath.toLowerCase(), segments)
    router.add(pathIndex, urlPath.toLowerCase(), segments)
  }

  return {
    findCanonical(pathname: string, method: string): string | null {
      const lower = pathname.toLowerCase()
      const [matches] = router.match(method === 'HEAD' ? 'GET' : method, lower)
      // Other methods only contribute to normalization when no current-method route exists (405).
      const candidates = matches.length ? matches : router.match(pathIndex, lower)[0]
      const segments = candidates[0]?.[0]
      if (!segments) return null
      const canonical = canonicalPathname(pathname, segments.join('/'))
      return canonical === pathname ? null : canonical
    },
  }
}

/**
 * Computes a GET/HEAD redirect for trailing slash or canonical path changes.
 *
 * @param url - Original request URL; query and origin are preserved.
 * @param method - Request method; methods other than GET/HEAD do not redirect.
 * @param trailingSlash - Resolved slash policy.
 * @param matchedPath - Canonical matched path, defaulting to the original pathname.
 * @returns The absolute redirect URL, or null when redirection is unnecessary.
 */
export function checkUrlNormalization(
  url: URL,
  method: string,
  trailingSlash: 'never' | 'always' | 'ignore',
  matchedPath = url.pathname,
): string | null {
  if (method !== 'GET' && method !== 'HEAD') {
    return null
  }

  const normalized = normalizeUrlPath(url, matchedPath, trailingSlash)
  return normalized.pathname === url.pathname ? null : normalized.href
}
