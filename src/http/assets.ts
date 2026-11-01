/** Build-owned public resource mapping, relative to the deployed output root. */
export interface StaticAssets {
  /** Normalized resource URL base supplied by Vite, with a trailing slash. */
  readonly base: string
  readonly files: Readonly<Record<string, { readonly path: string; readonly hashed: boolean }>>
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
