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
   * Website route directory, or `false` to disable page discovery.
   * @default 'app'
   */
  webDir?: string | false

  /**
   * Website URL prefix shared by server and browser page routes.
   * @default '/'
   */
  webPrefix?: string

  /**
   * Directory where generated code, definitions, and type declarations are written.
   * @default '.build'
   */
  generatedDir?: string

  /** Module exporting Api for separated page/API deployments; excludes local API routes. */
  apiTypes?: string
}

/** Complete Sark options shared by discovery, generation, and host integration. */
export interface ResolvedSarkOptions {
  readonly target: 'node' | 'cloudflare'
  readonly appEntry: string
  readonly apiDir: string | false
  readonly apiPrefix: string
  readonly webDir: string | false
  readonly webPrefix: string
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
  webDir: 'app',
  webPrefix: '/',
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
    webDir: input.webDir ?? DEFAULT_SARK_OPTIONS.webDir,
    webPrefix: normalizePrefix(input.webPrefix ?? DEFAULT_SARK_OPTIONS.webPrefix, 'webPrefix'),
    generatedDir: input.generatedDir ?? DEFAULT_SARK_OPTIONS.generatedDir,
    apiTypes: input.apiTypes,
  }
  if (result.target !== 'node' && result.target !== 'cloudflare') {
    throw new Error('target must be node or cloudflare.')
  }
  for (const [field, value] of Object.entries(result)) {
    if (
      ['appEntry', 'apiDir', 'webDir', 'generatedDir', 'apiTypes'].includes(field) &&
      !(value === false && (field === 'apiDir' || field === 'webDir')) &&
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
