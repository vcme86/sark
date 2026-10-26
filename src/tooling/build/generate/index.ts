/**
 * Application assembly code generation, type registrations, and runtime start scripts.
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { routeShape } from '../../../web/http/path'
import type { PageAssets } from '../../../web/page/assets'
import { writePageAssets } from '../assets'
import type { DiscoveredAppExports } from '../discover/app'
import type { DiscoveredPageTree } from '../discover/pages'
import type { DiscoveredRouteFile } from '../discover/routes'

function writeFileIfChanged(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8')
    if (existing === content) return
  }
  writeFileSync(filePath, content, 'utf-8')
}

/** Options controlling build artifact generation. */
export interface GenerateOptions {
  /** Target output directory (typically `.build`). */
  generatedDir: string
  /** Absolute path to the configured application entry. */
  appEntryPath: string
  /** Discovered named exports from the application entry. */
  appExports: DiscoveredAppExports
  /** Discovered API route files. */
  routes: DiscoveredRouteFile[]
  /** Discovered page tree, or undefined when pages are disabled or omitted. */
  pages?: DiscoveredPageTree
  /** Resolved API path prefix removed from generated client route keys. */
  apiPrefix: string
  /** Resolved page URL prefix applied to discovered pages. */
  webPrefix: string
  /** Resolved target platform for Node or Workers startup generation. */
  target: 'node' | 'cloudflare'
  /** Asset metadata available from the current engineering resolution phase. */
  assets?: PageAssets
  /** Module exporting an external Api type, already relative to generated code when local. */
  apiTypes?: string
}

function generateClientTsx(
  pages: DiscoveredPageTree,
  generatedDir: string,
  webPrefix: string,
): string {
  const imports: string[] = [
    `import '@vitejs/plugin-react/preamble'`,
    `import { hydratePageApplication, type ClientRoute } from '@olivaw/sark/runtime/page-browser'`,
    `import { notFound } from '@olivaw/sark/page'`,
  ]

  let rootLoadCode = ''
  if (pages.rootDocument) {
    const rel = relative(generatedDir, pages.rootDocument.filePath)
      .replace(/\\/g, '/')
      .replace(/\.tsx?$/, '')
    const importPath = rel.startsWith('.') ? rel : `./${rel}`
    rootLoadCode = `\n    rootLoad: () => import('${importPath}'),`
  }

  const clientRouteEntries: string[] = []

  for (const page of pages.pages) {
    const scopesCode: string[] = []

    for (const layout of page.layoutChain) {
      const rel = relative(generatedDir, layout.filePath)
        .replace(/\\/g, '/')
        .replace(/\.tsx?$/, '')
      const importPath = rel.startsWith('.') ? rel : `./${rel}`

      let errorLoadCode = ''
      if (layout.closestError) {
        const errRel = relative(generatedDir, layout.closestError.filePath)
          .replace(/\\/g, '/')
          .replace(/\.tsx?$/, '')
        const errPath = errRel.startsWith('.') ? errRel : `./${errRel}`
        errorLoadCode = `\n        errorLoad: () => import('${errPath}'),`
      }

      scopesCode.push(`      {
        id: ${JSON.stringify(`layout:${layout.scopeKey}`)},
        load: () => import('${importPath}'),${errorLoadCode}
      }`)
    }

    const pageRel = relative(generatedDir, page.filePath)
      .replace(/\\/g, '/')
      .replace(/\.tsx?$/, '')
    const pageImportPath = pageRel.startsWith('.') ? pageRel : `./${pageRel}`

    let pageErrorLoadCode = ''
    if (page.closestError) {
      const errRel = relative(generatedDir, page.closestError.filePath)
        .replace(/\\/g, '/')
        .replace(/\.tsx?$/, '')
      const errPath = errRel.startsWith('.') ? errRel : `./${errRel}`
      pageErrorLoadCode = `\n        errorLoad: () => import('${errPath}'),`
    }

    scopesCode.push(`      {
        id: ${JSON.stringify(`page:${page.scopeId}`)},
        load: () => import('${pageImportPath}'),${pageErrorLoadCode}
      }`)

    clientRouteEntries.push(`  {
    pattern: ${JSON.stringify(page.routePath.urlPath)},
    shapeKey: ${JSON.stringify(page.routePath.shapeKey)},
    paramNames: ${JSON.stringify(page.routePath.paramNames)},${rootLoadCode}
    scopes: [
${scopesCode.join(',\n')}
    ],
  }`)
  }

  const rootError = pages.errors.get('')
  const errorPath =
    rootError &&
    relative(generatedDir, rootError.filePath)
      .replace(/\\/g, '/')
      .replace(/\.tsx?$/, '')
  clientRouteEntries.push(`  {
    pattern: ${JSON.stringify(webPrefix === '/' ? '/*' : `${webPrefix}/*`)},
    shapeKey: 'not-found',
    paramNames: [],${rootLoadCode}
    scopes: [{
      id: 'not-found', component: () => null,
      loader: () => notFound('Page Not Found'),
      ${errorPath ? `errorLoad: () => import(${JSON.stringify(errorPath.startsWith('.') ? errorPath : './' + errorPath)}),` : ''}
    }],
  }`)

  return `${imports.join('\n')}

export const routes = [
${clientRouteEntries.join(',\n')}
] satisfies readonly ClientRoute[]

hydratePageApplication(routes)
`
}

/**
 * Writes application assembly and type declarations, plus a startup entry for Node or Workers.
 *
 * @param options - Resolved output paths, discovered modules, API/web prefixes, assets, and target.
 * @throws If a declaration is incompatible with the target or output files cannot be written.
 */
export function generateBuildArtifacts(options: GenerateOptions): void {
  const { generatedDir, appEntryPath, appExports, routes, pages, apiPrefix, webPrefix, target } =
    options
  mkdirSync(generatedDir, { recursive: true })
  if (options.apiTypes && routes.length) {
    throw new Error('apiTypes cannot be combined with discovered local API routes.')
  }
  const getRoutes = new Map(
    routes
      .filter((route) => route.routePath.method === 'GET')
      .map((route) => [routeShape(route.routePath.urlPath), route.relativePath]),
  )
  for (const page of pages?.pages ?? []) {
    const api = getRoutes.get(routeShape(page.routePath.urlPath))
    if (api) throw new Error(`Route conflict: API ${api} and page ${page.relativePath}`)
  }

  // Platform boundary validation
  if (target === 'cloudflare') {
    if (appExports.hasRuntime) {
      throw new Error(
        'Cloudflare Workers target does not support Node runtime configuration ("runtime"). Use Wrangler configuration for Workers bindings.',
      )
    }
    if (appExports.exports.includes('health')) {
      throw new Error(
        'Cloudflare Workers target does not support Node health probes ("health"). Probes are managed by the deployment platform.',
      )
    }
    if (appExports.exports.includes('metrics')) {
      throw new Error(
        'Cloudflare Workers target does not support Node metrics ("metrics"). Platform analytics are provided by Cloudflare.',
      )
    }
  }

  // 1. Generate app.ts
  const relAppEntry = relative(generatedDir, appEntryPath)
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '')
  const appImportPath = relAppEntry.startsWith('.') ? relAppEntry : `./${relAppEntry}`

  // Collect unique middleware files across routes
  const middlewareImports: string[] = []
  const middlewareVarMap = new Map<string, string>()

  for (const r of routes) {
    for (const mw of r.ancestorMiddlewares) {
      if (!middlewareVarMap.has(mw.filePath)) {
        const varName = `middleware_${middlewareVarMap.size}`
        middlewareVarMap.set(mw.filePath, varName)
        const relMw = relative(generatedDir, mw.filePath)
          .replace(/\\/g, '/')
          .replace(/\.tsx?$/, '')
        const mwImportPath = relMw.startsWith('.') ? relMw : `./${relMw}`
        middlewareImports.push(`import * as ${varName} from '${mwImportPath}'`)
      }
    }
  }

  const routeImports: string[] = []
  const routeEntries: string[] = []
  const routeApiEntries: string[] = []

  // Group routes by URL path for Api type mapping
  const pathMethodMap = new Map<string, Array<{ method: string; importName: string }>>()

  routes.forEach((r, idx) => {
    const importName = `route_${idx}`
    const relRoute = relative(generatedDir, r.filePath)
      .replace(/\\/g, '/')
      .replace(/\.tsx?$/, '')
    const routeImportPath = relRoute.startsWith('.') ? relRoute : `./${relRoute}`
    routeImports.push(`import ${importName} from '${routeImportPath}'`)

    let scopesPart = ''
    if (r.ancestorMiddlewares.length > 0) {
      const scopeItems = r.ancestorMiddlewares.map((mw) => {
        const varName = middlewareVarMap.get(mw.filePath)!
        const props: string[] = []
        if (mw.hasScope) props.push(`options: ${varName}.scope`)
        if (mw.hasDefault) props.push(`middleware: ${varName}.default`)
        return `{ ${props.join(', ')} }`
      })
      scopesPart = `, scopes: [${scopeItems.join(', ')}]`
    }

    routeEntries.push(
      `    { source: ${JSON.stringify(r.relativePath)}, routePath: ${JSON.stringify(r.routePath)}, declaration: ${importName}${scopesPart} },`,
    )

    let methods = pathMethodMap.get(r.routePath.clientPath)
    if (!methods) {
      methods = []
      pathMethodMap.set(r.routePath.clientPath, methods)
    }
    methods.push({ method: r.routePath.method, importName })
  })

  for (const [urlPath, methods] of pathMethodMap.entries()) {
    const methodLines: string[] = []
    for (const m of methods) {
      methodLines.push(
        `    ${m.method}: EndpointFromRoute<typeof ${m.importName}, ${JSON.stringify(urlPath)}>`,
      )
      if (m.method === 'GET') {
        methodLines.push(
          `    HEAD: { input: EndpointFromRoute<typeof ${m.importName}, ${JSON.stringify(urlPath)}>['input']; output: Response }`,
        )
      }
    }
    const prefix = apiPrefix === '/' ? '' : apiPrefix
    const relativePath = urlPath === prefix ? '/' : urlPath.slice(prefix.length)
    routeApiEntries.push(`  ${JSON.stringify(relativePath)}: {\n${methodLines.join('\n')}\n  }`)
  }

  // Page SSR handling setup in app.ts
  const hasPages = Boolean(pages && pages.pages.length > 0)
  const pageImports: string[] = []
  let pageHandlerCode = ''
  const pageEntriesCode: string[] = []

  if (hasPages && pages) {
    pageImports.push(
      `import { createPageHandler, createPage404Handler, resolvePageConfig, resolveClientAssets, type ServerPageRoute } from '@olivaw/sark/runtime/page-server'`,
    )

    const pageModuleMap = new Map<string, string>()
    function getPageImport(filePath: string, prefix: string): string {
      let name = pageModuleMap.get(filePath)
      if (!name) {
        name = `${prefix}_${pageModuleMap.size}`
        pageModuleMap.set(filePath, name)
        const rel = relative(generatedDir, filePath)
          .replace(/\\/g, '/')
          .replace(/\.tsx?$/, '')
        const importPath = rel.startsWith('.') ? rel : `./${rel}`
        pageImports.push(`import * as ${name} from '${importPath}'`)
      }
      return name
    }

    let rootComponentCode = 'undefined'
    if (pages.rootDocument) {
      const rootName = getPageImport(pages.rootDocument.filePath, 'root')
      rootComponentCode = `${rootName}.default`
    }

    const pageRoutesCode: string[] = []
    for (const page of pages.pages) {
      const scopesCode: string[] = []
      for (const layout of page.layoutChain) {
        const layoutVar = getPageImport(layout.filePath, 'layout')
        const errorVar = layout.closestError
          ? getPageImport(layout.closestError.filePath, 'error')
          : undefined
        scopesCode.push(`      {
        id: ${JSON.stringify(`layout:${layout.scopeKey}`)},
        component: ${layoutVar}.default,
        ${errorVar ? `errorComponent: ${errorVar}.default,` : ''}
        ${layout.exports.hasLoader ? `loader: ${layoutVar}.loader,` : ''}
        ${layout.exports.hasMeta ? `meta: ${layoutVar}.meta,` : ''}
        ${layout.exports.hasCache ? `cache: ${layoutVar}.cache,` : ''}
        ${layout.exports.hasShouldRevalidate ? `shouldRevalidate: ${layoutVar}.shouldRevalidate,` : ''}
      }`)
      }

      const pageVar = getPageImport(page.filePath, 'page')
      const errorVar = page.closestError
        ? getPageImport(page.closestError.filePath, 'error')
        : undefined
      scopesCode.push(`      {
        id: ${JSON.stringify(`page:${page.scopeId}`)},
        component: ${pageVar}.default,
        ${errorVar ? `errorComponent: ${errorVar}.default,` : ''}
        ${page.exports.hasLoader ? `loader: ${pageVar}.loader,` : ''}
        ${page.exports.hasMeta ? `meta: ${pageVar}.meta,` : ''}
        ${page.exports.hasCache ? `cache: ${pageVar}.cache,` : ''}
        ${page.exports.hasShouldRevalidate ? `shouldRevalidate: ${pageVar}.shouldRevalidate,` : ''}
      }`)

      const middlewaresCode: string[] = []
      for (const mw of page.middlewareChain) {
        const mwVar = getPageImport(mw.filePath, 'mw')
        middlewaresCode.push(
          `{ ${[mw.exports.hasScope ? `options: ${mwVar}.scope` : '', mw.exports.hasDefault ? `middleware: ${mwVar}.default` : ''].filter(Boolean).join(', ')} }`,
        )
      }

      pageRoutesCode.push(`  {
    pattern: ${JSON.stringify(page.routePath.urlPath)},
    shapeKey: ${JSON.stringify(page.routePath.shapeKey)},
    paramNames: ${JSON.stringify(page.routePath.paramNames)},
    rootComponent: ${rootComponentCode},
    httpScopes: [${middlewaresCode.join(', ')}],
    scopes: [
${scopesCode.join(',\n')}
    ],
  }`)
    }

    pages.pages.forEach((page, index) => {
      const routePath = {
        ...page.routePath,
        segments: [...page.routePath.segments],
        clientPath: page.routePath.urlPath,
        method: 'GET',
        isSse: false,
        isWs: false,
      }
      pageEntriesCode.push(`    {
      kind: 'page',
      source: ${JSON.stringify(page.relativePath)},
      routePath: ${JSON.stringify(routePath)},
      scopes: pageRoutes[${index}].httpScopes,
      pageHandler: createPageHandler(pageRoutes[${index}], () => resolveClientAssets(pageAssets, pageRoutes[${index}].pattern)),
    },`)
    })
    const rootError = pages.errors.get('')
    const errorCode = rootError
      ? `${getPageImport(rootError.filePath, 'root_error')}.default`
      : 'undefined'
    pageHandlerCode = `
export const pageRoutes = [
${pageRoutesCode.join(',\n')}
] satisfies readonly ServerPageRoute[]

export const page404Handler = createPage404Handler(
  ${rootComponentCode},
  ${errorCode},
  () => resolveClientAssets(pageAssets, '/*'),
)
`
  }

  const appTsContent = `import type { Hono } from 'hono'
import { createDefinition } from '@olivaw/sark/runtime/core'
import type { EndpointFromRoute } from '@olivaw/sark/server'
${options.apiTypes ? `import type { Api as ExternalApi } from ${JSON.stringify(options.apiTypes)}` : ''}
${appExports.hasApp ? `import { app } from '${appImportPath}'` : ''}
${appExports.hasRuntime ? `import { runtime } from '${appImportPath}'` : ''}
${appExports.exports.includes('page') ? `import { page } from '${appImportPath}'` : ''}
${middlewareImports.join('\n')}
${routeImports.join('\n')}
${pageImports.join('\n')}
${hasPages || options.assets ? "import { pageAssets } from './page-assets'" : ''}

${pageHandlerCode}

export const definition = createDefinition({
  ${appExports.hasApp ? 'app,' : ''}
  ${appExports.hasRuntime ? 'declarations: [runtime] as const,' : ''}
  ${appExports.exports.includes('page') ? 'page,' : ''}
  apiPrefix: ${JSON.stringify(apiPrefix)},
  webPrefix: ${JSON.stringify(webPrefix)},
  routes: [
${routeEntries.join('\n')}
${pageEntriesCode.join('\n')}
  ],
  ${hasPages ? 'page404Handler,' : ''}
  ${hasPages ? `resolvePageConfig: (env: unknown) => resolvePageConfig(${appExports.exports.includes('page') ? 'page' : 'undefined'}, env, ${JSON.stringify(apiPrefix)}),` : ''}
  ${options.assets ? 'assets: pageAssets,' : ''}
})

${appExports.hasRuntime ? `export { runtime } from '${appImportPath}'` : 'export const runtime = undefined'}

export type AppDefinition = typeof definition
export type App = Hono<any>
export type Api = ${
    options.apiTypes
      ? 'ExternalApi'
      : `{
${routeApiEntries.join('\n')}
}`
  }
`
  writeFileIfChanged(join(generatedDir, 'app.ts'), appTsContent)
  if (options.assets) {
    writePageAssets({ generatedDir }, options.assets)
  }

  // 2. Generate resources-types.ts
  const resourcesTypesContent = `// Generated resource types
export type Resources = {}
`
  writeFileIfChanged(join(generatedDir, 'resources-types.ts'), resourcesTypesContent)

  // 3. Generate services-types.ts
  const servicesTypesContent = `// Generated services types
export type Services = {}
`
  writeFileIfChanged(join(generatedDir, 'services-types.ts'), servicesTypesContent)

  // 4. Generate types.d.ts with Register.api module augmentation
  const typesDtsContent = `// Generated type registrations
import type { Api } from './app'

declare module '@olivaw/sark/http' {
  interface Register {
    api: Api
  }
}

export type { AppDefinition, Api, App } from './app'
`
  writeFileIfChanged(join(generatedDir, 'types.d.ts'), typesDtsContent)

  // 5. Generate client.tsx if pages exist, or clean up if none
  if (hasPages && pages) {
    writeFileIfChanged(
      join(generatedDir, 'client.tsx'),
      generateClientTsx(pages, generatedDir, webPrefix),
    )
  } else {
    rmSync(join(generatedDir, 'client.tsx'), { force: true })
  }

  // 6. Generate runtime-specific entrypoint
  if (target === 'node') {
    rmSync(join(generatedDir, 'worker.ts'), { force: true })
    const startTsContent = `import { createApp } from '@olivaw/sark/server'
import { loadNodeEnv, startNodeServer } from '@olivaw/sark/runtime/node'
${options.assets ? "import { fileURLToPath } from 'node:url'" : ''}
${options.assets ? "import { dirname } from 'node:path'" : ''}

loadNodeEnv()

// Dynamic import after environment initialization
const { definition, runtime } = await import('./app')
const instance = await createApp(definition, { env: process.env })
await startNodeServer(instance, runtime, process.env${options.assets ? ', { rootDir: dirname(fileURLToPath(import.meta.url)), assets: definition.assets! }' : ''})
`
    writeFileIfChanged(join(generatedDir, 'start.ts'), startTsContent)
  } else if (target === 'cloudflare') {
    rmSync(join(generatedDir, 'start.ts'), { force: true })
    const workerTsContent = `/// <reference types="vite/client" />
import { createWorkerHandler, type CloudflareExecutionContext } from '@olivaw/sark/runtime/cloudflare'
import { definition } from './app'

declare global {
  interface Env {}
}

const handler = createWorkerHandler(definition, import.meta.env.PROD)

export default {
  fetch(request: Request, env: Env, ctx: CloudflareExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx)
  },
}
`
    writeFileIfChanged(join(generatedDir, 'worker.ts'), workerTsContent)
  }
}
