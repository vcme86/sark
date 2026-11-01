import type { BuildAssets } from '../../http/assets'

/** Entry and styles selected from the build-owned mapping for this route. */
export interface ClientAssetManifest {
  readonly bootstrapModules: readonly string[]
  readonly stylesheets: readonly string[]
  readonly routeStyles: BuildAssets['styles']
}

/**
 * Selects already resolved resources without filesystem reads or URL fallbacks.
 *
 * @param assets - Generated browser entry and route resource mapping.
 * @param pattern - Matched route pattern, or the generated root 404 key.
 * @returns The entry modules, this route's stylesheets, and all browser route styles.
 */
export function resolveClientAssets(assets: BuildAssets, pattern: string): ClientAssetManifest {
  return {
    bootstrapModules: assets.entry ? [assets.entry] : [],
    stylesheets: assets.styles[pattern] ?? [],
    routeStyles: assets.styles,
  }
}
