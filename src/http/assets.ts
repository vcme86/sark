/** Build-owned public resource mapping, relative to the deployed output root. */
export interface StaticAssets {
  /** Normalized resource URL base supplied by Vite, with a trailing slash. */
  readonly base: string
  readonly files: Readonly<Record<string, { readonly path: string; readonly hashed: boolean }>>
}

/** Finds an exact build-owned URL without opening a file or decoding the same path twice. */
export function findStaticAsset(
  assets: StaticAssets,
  pathname: string,
): StaticAssets['files'][string] | undefined {
  const base = new URL(assets.base, 'http://assets.local/').pathname
  if (!pathname.startsWith(base)) return
  try {
    const key = decodeURIComponent(pathname.slice(base.length))
    if (Object.hasOwn(assets.files, key)) return assets.files[key]
  } catch {
    // Invalid URL encoding cannot identify a build resource.
  }
}

/**
 * Encodes each resource path segment so filename punctuation does not become URL syntax.
 *
 * @param base - Resolved Vite resource base; empty and ./ bases use the origin root.
 * @param path - Slash-separated resource path relative to the base.
 * @returns Public resource URL with path separators preserved.
 */
export function assetUrl(base: string, path: string): string {
  return (
    (base === '' || base === './' ? '/' : base) + path.split('/').map(encodeURIComponent).join('/')
  )
}

/** Complete build resources, including optional page entry and per-route styles. */
export interface BuildAssets extends StaticAssets {
  readonly entry?: string
  readonly styles: Readonly<Record<string, readonly string[]>>
}
