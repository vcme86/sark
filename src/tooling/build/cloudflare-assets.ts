/** Native Cloudflare Static Assets response policy emitted with the client build. */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { assetUrl, type StaticAssets } from '../../http/assets'
import { DEFAULT_SECURITY_HEADERS } from '../../http/defaults'

/**
 * Writes platform defaults without intercepting static requests in the Worker.
 * An application-owned _headers file replaces these defaults as a whole.
 *
 * @param outputDir - Client output directory selected by the official Vite plugin.
 * @param assets - Completed manifest and public file mapping, used only during the build.
 * @param publicDir - Vite public directory, or false when disabled.
 * @throws If generated rules exceed Cloudflare's rule count or line length limits.
 */
export function writeCloudflareAssetHeaders(
  outputDir: string,
  assets: StaticAssets,
  publicDir: string | false,
): void {
  if (publicDir && existsSync(join(publicDir, '_headers'))) return

  const publicFiles = Object.entries(assets.files)
    .filter(([, file]) => !file.hashed)
    .map(([path]) => path)
  const immutable = new Set<string>()
  for (const [path, file] of Object.entries(assets.files)) {
    if (!file.hashed) continue
    const directory = dirname(path).replaceAll('\\', '/')
    const exclusivelyHashed =
      directory !== '.' && !publicFiles.some((publicPath) => publicPath.startsWith(directory + '/'))
    immutable.add(exclusivelyHashed ? directory + '/*' : path)
  }

  // A directory rule covers its children; emitting both would duplicate Cache-Control values.
  const patterns = [...immutable].toSorted()
  const cacheRules = patterns.filter(
    (pattern) =>
      !patterns.some(
        (parent) =>
          parent !== pattern && parent.endsWith('/*') && pattern.startsWith(parent.slice(0, -1)),
      ),
  )
  const rules = [
    '/*\n' +
      Object.entries(DEFAULT_SECURITY_HEADERS)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join('\n'),
    ...cacheRules.map((pattern) => {
      const url = pattern.endsWith('/*')
        ? assetUrl(assets.base, pattern.slice(0, -1)) + '*'
        : assetUrl(assets.base, pattern)
      return `${url}\n  Cache-Control: public, max-age=31536000, immutable`
    }),
  ]
  if (rules.length > 100)
    throw new Error(
      'Generated Cloudflare _headers exceeds 100 rules. Keep hashed assets separate from public files, or provide your own publicDir/_headers.',
    )
  const contents = rules.join('\n\n') + '\n'
  if (contents.split('\n').some((line) => line.length > 2000))
    throw new Error(
      'Generated Cloudflare _headers exceeds the 2000-character line limit. Shorten asset URLs, or provide your own publicDir/_headers.',
    )
  writeFileSync(join(outputDir, '_headers'), contents)
}
