/** Project discovery and generation shared by the CLI and Vite plugin. */
import { BuildEnvironment, createIdResolver, type ResolvedConfig } from 'vite'

import {
  type ResolvedProjectConfig,
  resolveProjectConfig,
  resolveSarkOptions,
  type SarkOptions,
} from '../config'
import { developmentAssets } from './assets'
import { discoverAppEntry, discoverDatabaseDriver, type DiscoveredAppExports } from './discover/app'
import { type DiscoveredPageTree, discoverPages } from './discover/pages'
import { discoverApiRoutes } from './discover/routes'
import { generateBuildArtifacts } from './generate'

/**
 * Runs discovery and code generation for the Vite plugin and CLI.
 *
 * @param projectRoot - Resolved Vite project root used to resolve all relative option paths.
 * @param options - Sark discovery and generation settings; omitted values use shared defaults.
 * @throws If discovery detects invalid exports or route conflicts, or generated files cannot be written.
 */
export function generateProject(projectRoot: string, options: SarkOptions = {}): void {
  generateResolvedProject(resolveProjectConfig(projectRoot, resolveSarkOptions(options)), '/')
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
  return generateResolvedProject(project, config.base, appExports)
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
): DiscoveredPageTree | undefined {
  const routes = config.apiDir === false ? [] : discoverApiRoutes(config.apiDir, config.apiPrefix)
  const pages = config.webDir === false ? undefined : discoverPages(config.webDir, config.webPrefix)
  generateBuildArtifacts({
    generatedDir: config.generatedDir,
    appEntryPath: config.appEntryPath,
    appExports,
    routes,
    pages,
    apiPrefix: config.apiPrefix,
    webPrefix: config.webPrefix,
    target: config.target,
    apiTypes: config.apiTypes,
    assets: base === undefined ? undefined : developmentAssets(base, pages, config.generatedDir),
  })
  return pages
}
