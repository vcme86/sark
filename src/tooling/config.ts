import { resolve } from 'node:path'

import { DEFAULT_API_PREFIX } from '../web/http/defaults'

/** Configuration options for the Sark Vite plugin. */
export interface SarkOptions {
  /**
   * Deployment target platform.
   * @default 'node'
   */
  target?: 'node' | 'cloudflare'

  /**
   * Application definition entry file name or relative path.
   * @default 'app.ts'
   */
  appEntry?: string

  /**
   * Directory scanned for API routes, or `false` to disable API route discovery.
   * @default 'api'
   */
  apiDir?: string | false

  /**
   * Base URL path prefix prepended to all discovered API routes.
   * @default '/api'
   */
  apiPrefix?: string

  /**
   * Reserved page route directory, or `false`. Page discovery is not yet implemented.
   * @default 'app'
   */
  pageDir?: string | false

  /**
   * Reserved page URL prefix; not yet consumed by generation.
   * @default '/'
   */
  pagePrefix?: string

  /**
   * Directory where generated code, definitions, and type declarations are written.
   * @default '.build'
   */
  generatedDir?: string

  /** Reserved external Api type source; not yet consumed by generation. */
  apiTypes?: string
}

/** Complete Sark options shared by discovery, generation, and host integration. */
export interface ResolvedSarkOptions {
  readonly target: 'node' | 'cloudflare'
  readonly appEntry: string
  readonly apiDir: string | false
  readonly apiPrefix: string
  readonly pageDir: string | false
  readonly pagePrefix: string
  readonly generatedDir: string
  readonly apiTypes?: string
}

/** Absolute discovery paths bound to a resolved project root. */
export interface ResolvedProjectConfig {
  readonly root: string
  readonly appEntryPath: string
  readonly apiDir: string | false
  readonly generatedDir: string
  readonly options: ResolvedSarkOptions
}

const DEFAULT_SARK_OPTIONS: ResolvedSarkOptions = {
  target: 'node',
  appEntry: 'app.ts',
  apiDir: 'api',
  apiPrefix: DEFAULT_API_PREFIX,
  pageDir: 'app',
  pagePrefix: '/',
  generatedDir: '.build',
}

function normalizePrefix(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\s?#\\]/.test(value) ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`${field} must be an absolute URL path prefix.`)
  }
  return value.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

/**
 * Applies Sark defaults and validates engineering options without executing declarations.
 *
 * @param input - Public plugin or standalone generation options.
 * @returns Complete options with canonical URL prefixes.
 * @throws If an option has an invalid target, empty path, or malformed prefix.
 */
export function resolveSarkOptions(input: SarkOptions = {}): ResolvedSarkOptions {
  for (const [field, value] of Object.entries(input)) {
    if (value === null) throw new Error(`sark.${field} does not accept null.`)
  }
  const result: ResolvedSarkOptions = {
    target: input.target ?? DEFAULT_SARK_OPTIONS.target,
    appEntry: input.appEntry ?? DEFAULT_SARK_OPTIONS.appEntry,
    apiDir: input.apiDir ?? DEFAULT_SARK_OPTIONS.apiDir,
    apiPrefix: normalizePrefix(input.apiPrefix ?? DEFAULT_SARK_OPTIONS.apiPrefix, 'apiPrefix'),
    pageDir: input.pageDir ?? DEFAULT_SARK_OPTIONS.pageDir,
    pagePrefix: normalizePrefix(input.pagePrefix ?? DEFAULT_SARK_OPTIONS.pagePrefix, 'pagePrefix'),
    generatedDir: input.generatedDir ?? DEFAULT_SARK_OPTIONS.generatedDir,
    apiTypes: input.apiTypes,
  }
  if (result.target !== 'node' && result.target !== 'cloudflare') {
    throw new Error('target must be node or cloudflare.')
  }
  for (const [field, value] of Object.entries(result)) {
    if (
      ['appEntry', 'apiDir', 'pageDir', 'generatedDir', 'apiTypes'].includes(field) &&
      !(value === false && (field === 'apiDir' || field === 'pageDir')) &&
      value !== undefined &&
      (typeof value !== 'string' || !value.trim())
    ) {
      throw new Error(`${field} must be a non-empty path or module name.`)
    }
  }
  return result
}

/**
 * Binds already resolved Sark options to the host's project root.
 *
 * @param projectRoot - Project root supplied by Vite or the standalone generation caller.
 * @param options - Complete Sark options.
 * @returns Absolute paths for the shared discovery and generation flow.
 */
export function resolveProjectConfig(
  projectRoot: string,
  options: ResolvedSarkOptions,
): ResolvedProjectConfig {
  const root = resolve(projectRoot)
  return {
    root,
    appEntryPath: resolve(root, options.appEntry),
    apiDir: options.apiDir === false ? false : resolve(root, options.apiDir),
    generatedDir: resolve(root, options.generatedDir),
    options,
  }
}
