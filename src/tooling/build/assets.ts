import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { type Manifest, normalizePath, parseSync, type ViteDevServer } from 'vite'

import { assetUrl } from '../../http/assets'
import type { PageAssets } from '../../page/assets'
import type { ResolvedProjectConfig } from '../config'
import type { DiscoveredPageTree } from './discover/pages'

/**
 * Lists regular public files without following symbolic links.
 *
 * @param publicDir - Vite's resolved public directory, or false when disabled.
 * @returns Sorted, slash-separated paths relative to publicDir; absent directories yield no files.
 */
export function publicFiles(publicDir: string | false): string[] {
  if (!publicDir || !existsSync(publicDir)) return []
  const root = publicDir
  const files: string[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(relative(root, path).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return files.toSorted()
}

/**
 * Writes the resource module only when its contents change, avoiding unnecessary HMR updates.
 *
 * @param project - Resolved generation directory, already created by application generation.
 * @param assets - Resource mapping to embed in the generated module.
 */
export function writePageAssets(
  project: Pick<ResolvedProjectConfig, 'generatedDir'>,
  assets: PageAssets,
): void {
  const path = join(project.generatedDir, 'page-assets.ts')
  const code = `export const pageAssets = ${JSON.stringify(assets)}\n`
  if (!existsSync(path) || readFileSync(path, 'utf8') !== code) writeFileSync(path, code)
}

/**
 * Prepares the development entry URL before module-graph resource discovery.
 *
 * @param base - Resolved Vite resource base, including its trailing slash.
 * @param pages - Discovered page tree, or undefined when disabled.
 * @param generatedDir - Absolute directory containing the generated client.tsx entry.
 * @returns Entry metadata with empty file/style maps; page-free applications have no entry.
 */
export function developmentAssets(
  base: string,
  pages: DiscoveredPageTree | undefined,
  generatedDir: string,
): PageAssets {
  return {
    base,
    entry: pages?.pages.length
      ? `${base}@fs${normalizePath(join(generatedDir, 'client.tsx'))}`
      : undefined,
    files: {},
    styles: {},
  }
}

/**
 * Resolves public URLs, deployed file locations, and route CSS from a completed client build.
 *
 * @param manifest - Vite client manifest keyed by source module paths.
 * @param project - Resolved project paths and deployment target.
 * @param pages - Discovered page chains used to associate styles with routes.
 * @param base - Final Vite resource base; relative bases are served from the application origin.
 * @param publicPaths - Files copied from publicDir, relative to that directory.
 * @returns Host-specific public file mapping, browser entry URL, and per-route styles.
 * @throws {Error} If a public file conflicts with a build asset or the page entry is missing.
 */
export function productionAssets(
  manifest: Manifest,
  project: ResolvedProjectConfig,
  pages: DiscoveredPageTree | undefined,
  base: string,
  publicPaths: readonly string[],
): PageAssets {
  if (base === '' || base === './') base = '/'
  const files: Record<string, { path: string; hashed: boolean }> = {}
  for (const chunk of Object.values(manifest)) {
    for (const path of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      files[path] = {
        path: project.target === 'node' ? `client/${path}` : path,
        hashed: true,
      }
    }
  }
  for (const path of publicPaths) {
    if (Object.hasOwn(files, path))
      throw new Error(`Public file conflicts with a generated asset: ${path}`)
    files[path] = {
      path: project.target === 'node' ? `public/${path}` : path,
      hashed: false,
    }
  }
  const entryKey = relative(project.root, join(project.generatedDir, 'client.tsx')).replace(
    /\\/g,
    '/',
  )

  function cssFor(paths: readonly string[]) {
    const result = new Set<string>()
    const visited = new Set<string>()
    function visit(key: string, dynamic = true) {
      if (visited.has(key)) return
      visited.add(key)
      const chunk = manifest[key]
      if (!chunk) return
      for (const dependency of chunk.imports ?? []) visit(dependency)
      if (dynamic) for (const dependency of chunk.dynamicImports ?? []) visit(dependency)
      for (const css of chunk.css ?? []) result.add(assetUrl(base, css))
    }
    visit(entryKey, false)
    for (const path of paths) visit(relative(project.root, path).replace(/\\/g, '/'))
    return [...result]
  }

  const styles: Record<string, string[]> = {}
  const rootFiles = [
    ...(pages?.rootDocument ? [pages.rootDocument.filePath] : []),
    ...(pages?.errors.get('') ? [pages.errors.get('')!.filePath] : []),
  ]
  if (pages?.pages.length) {
    styles['/*'] = cssFor(rootFiles)
    styles[project.webPrefix === '/' ? '/*' : project.webPrefix + '/*'] = styles['/*']
  }
  for (const page of pages?.pages ?? []) {
    styles[page.routePath.urlPath] = cssFor([
      ...rootFiles,
      ...page.layoutChain.flatMap((layout) => [
        layout.filePath,
        ...(layout.closestError ? [layout.closestError.filePath] : []),
      ]),
      page.filePath,
      ...(page.closestError ? [page.closestError.filePath] : []),
    ])
  }
  const entry = manifest[entryKey]
  if (pages?.pages.length && !entry) throw new Error(`Client manifest is missing ${entryKey}.`)
  return { base, files, styles, entry: entry ? assetUrl(base, entry.file) : undefined }
}

/**
 * Transforms browser modules to collect development resources without evaluating their bodies.
 * Each route collects its root, layouts, page, and error-component dependencies.
 *
 * @param server - Vite server providing the client module graph and final resource base.
 * @param pages - Discovered page tree, or undefined for an API-only application.
 * @param project - Resolved project and generation paths.
 * @returns Public development files, the client entry, and styles for each page chain.
 * @throws {Error} If Vite cannot transform or resolve a required browser module.
 */
export async function collectDevelopmentAssets(
  server: ViteDevServer,
  pages: DiscoveredPageTree | undefined,
  project: ResolvedProjectConfig,
): Promise<PageAssets> {
  const assets = developmentAssets(server.config.base, pages, project.generatedDir)
  const styles: Record<string, string[]> = {}
  const files: Record<string, { path: string; hashed: boolean }> = {}
  const rootFiles = [
    ...(pages?.rootDocument ? [pages.rootDocument.filePath] : []),
    ...(pages?.errors.get('') ? [pages.errors.get('')!.filePath] : []),
  ]
  const chains = (pages?.pages ?? []).map((page) => ({
    pattern: page.routePath.urlPath,
    files: [
      ...rootFiles,
      ...page.layoutChain.flatMap((layout) => [
        layout.filePath,
        ...(layout.closestError ? [layout.closestError.filePath] : []),
      ]),
      page.filePath,
      ...(page.closestError ? [page.closestError.filePath] : []),
    ],
  }))
  if (pages?.pages.length) chains.push({ pattern: '/*', files: rootFiles })
  function register(url: string) {
    const browserUrl = url.startsWith('\0') ? '/@id/__x00__' + url.slice(1) : url
    const path = browserUrl.split('?')[0].replace(/^\//, '')
    files[path] = { path, hashed: false }
  }
  function registerModule(module: { url: string; file: string | null }) {
    register(module.url)
    if (module.file) {
      const local = normalizePath(relative(server.config.root, module.file))
      if (local !== '..' && !local.startsWith('../')) register('/' + local)
    }
  }
  async function visit(url: string, css: Set<string>, visited: Set<string>): Promise<void> {
    if (visited.has(url)) return
    visited.add(url)
    register(url)
    const [pathname, query] = url.split('?')
    const params = new URLSearchParams(query)
    const isCss = /\.(css|scss|sass|less|styl|stylus)$/.test(pathname)
    if (isCss && !params.has('inline') && !params.has('raw') && !params.has('url')) {
      params.delete('import')
      params.set('direct', '')
      css.add(server.config.base + pathname.replace(/^\//, '') + '?' + params)
    }
    const id = url.startsWith('/@id/') ? url.slice('/@id/'.length).replace('__x00__', '\0') : url
    const transformed = await server.environments.client.transformRequest(id)
    const module = await server.environments.client.moduleGraph.getModuleByUrl(id)
    if (module) registerModule(module)
    const imports = [...(module?.importedModules ?? [])]
    for (const dependency of imports) if (dependency.type === 'asset') registerModule(dependency)
    const dependencies = new Set(
      imports
        .filter((dependency) => dependency.type !== 'asset')
        .map((dependency) => dependency.url),
    )
    // Client/runtime plugins can inject imports after Vite records its module graph.
    if (transformed && !isCss)
      for (const node of parseSync('browser.js', transformed.code).program.body) {
        if (
          (node.type === 'ImportDeclaration' ||
            node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportAllDeclaration') &&
          node.source
        ) {
          const dependency = node.source.value
          if (dependency.startsWith('/'))
            dependencies.add(
              dependency.startsWith(server.config.base)
                ? '/' + dependency.slice(server.config.base.length)
                : dependency,
            )
        }
      }
    await Promise.all([...dependencies].map((dependency) => visit(dependency, css, visited)))
  }
  for (const chain of chains) {
    const css = new Set<string>()
    const visited = new Set<string>()
    for (const file of chain.files) await visit('/@fs' + normalizePath(file), css, visited)
    styles[chain.pattern] = [...css]
  }
  if (pages?.pages.length) {
    const webPrefix = project.webPrefix
    styles[webPrefix === '/' ? '/*' : webPrefix + '/*'] = styles['/*']
    const clientUrl = new URL(assets.entry!, 'http://vite.local').pathname.slice(
      server.config.base.length - 1,
    )
    await visit(clientUrl, new Set(), new Set())
    await visit('/@vite/client', new Set(), new Set())
  }
  for (const path of publicFiles(server.config.publicDir)) files[path] = { path, hashed: false }
  return { ...assets, files, styles }
}
