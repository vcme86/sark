/** Project discovery and generation shared by the CLI and Vite plugin. */
import { BuildEnvironment, createIdResolver, loadEnv, type ResolvedConfig } from 'vite'

import {
  type PluginOptions,
  type ResolvedProjectConfig,
  resolvePluginOptions,
  resolveProjectConfig,
} from '../config'
import { createDevelopmentAssets } from './assets'
import { discoverAppEntry, discoverDatabaseDriver, type DiscoveredAppExports } from './discover/app'
import { type DiscoveredPageTree, discoverPages } from './discover/pages'
import { discoverApiRoutes } from './discover/routes'
import { generateBuildArtifacts } from './generate'
import { resolveEffectiveWranglerTriggers } from './wrangler'

/**
 * Runs discovery and code generation for the Vite plugin and CLI.
 *
 * @param projectRoot - Resolved Vite project root used to resolve all relative option paths.
 * @param options - Sark discovery and generation settings; omitted values use shared defaults.
 * @throws If discovery detects invalid exports or route conflicts, or generated files cannot be written.
 */
export function generateProject(projectRoot: string, options: PluginOptions = {}): void {
  generateResolvedProject(resolveProjectConfig(projectRoot, resolvePluginOptions(options)), '/')
}

/**
 * Completes discovery using Vite's resolved server environment before generating artifacts.
 *
 * @param config - Vite configuration, including the server target's aliases and resolution conditions.
 * @param project - Parsed Sark engineering options and absolute project paths.
 * @returns Discovered pages after capability origins and target constraints have been checked.
 */
export async function generateConfiguredProject(
  config: ResolvedConfig,
  project: ResolvedProjectConfig,
): Promise<DiscoveredPageTree | undefined> {
  const appExports: DiscoveredAppExports = discoverAppEntry(project.appEntryPath)
  if (appExports.exports.includes('database')) {
    const environment = new BuildEnvironment('ssr', config)
    const resolveId = createIdResolver(config)
    appExports.databaseDriver = await discoverDatabaseDriver(project.appEntryPath, (id, importer) =>
      resolveId(environment, id, importer),
    )
  }
  // Match the official plugin: Cloudflare environment files are loaded from project root.
  const env =
    project.target === 'cloudflare' ? loadEnv(config.mode, config.root, ['CLOUDFLARE_']) : undefined
  const triggers =
    project.target === 'cloudflare'
      ? resolveEffectiveWranglerTriggers(
          config.root,
          env?.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH,
          env?.CLOUDFLARE_ENV,
        )
      : undefined
  return generateResolvedProject(project, config.base, appExports, { triggers })
}

/**
 * Generates artifacts using the owning entry's complete project configuration.
 *
 * @param config - Resolved options and absolute discovery paths.
 * @param base - Final Vite resource base; omitted during early entry generation.
 * @returns Discovered page metadata, or undefined when page discovery is disabled.
 * @throws If discovery detects conflicts or generation cannot write its artifacts.
 */
export function generateResolvedProject(
  config: ResolvedProjectConfig,
  base?: string,
  appExports = discoverAppEntry(config.appEntryPath),
  platform?: {
    readonly bootstrap?: boolean
    readonly triggers?: { readonly crons?: readonly string[] }
  },
): DiscoveredPageTree | undefined {
  const routes = config.apiDir === false ? [] : discoverApiRoutes(config.apiDir, config.apiPrefix)
  const pages = config.webDir === false ? undefined : discoverPages(config.webDir, config.webPrefix)
  generateBuildArtifacts({
    validateJobs: !platform?.bootstrap,
    triggers: platform
      ? platform.triggers
      : config.target === 'cloudflare'
        ? resolveEffectiveWranglerTriggers(config.root)
        : undefined,
    generatedDir: config.generatedDir,
    appEntryPath: config.appEntryPath,
    appExports,
    routes,
    pages,
    apiPrefix: config.apiPrefix,
    webPrefix: config.webPrefix,
    target: config.target,
    apiTypes: config.apiTypes,
    assets:
      base === undefined ? undefined : createDevelopmentAssets(base, pages, config.generatedDir),
  })
  return pages
}
