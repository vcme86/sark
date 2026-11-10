import type { BuildAssets } from '../../http/assets'

/** Entry and styles selected from the build-owned mapping for this route. */
export interface ClientAssetManifest {
  readonly bootstrapModules: readonly string[]
  readonly stylesheets: readonly string[]
}

/**
 * Selects already resolved resources without filesystem reads or URL fallbacks.
 *
 * @param assets - Generated browser entry and route resource mapping.
 * @param pattern - Matched route pattern, or the generated root 404 key.
 * @returns The entry modules and this route's stylesheets.
 */
export function resolveClientAssets(
  assets: Pick<BuildAssets, 'entry' | 'styles'>,
  pattern: string,
): ClientAssetManifest {
  return {
    bootstrapModules: assets.entry ? [assets.entry] : [],
    stylesheets: assets.styles[pattern] ?? [],
  }
}
