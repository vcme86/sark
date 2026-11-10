/**
 * Application assembly code generation, type registrations, and runtime start scripts.
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { BuildAssets } from '../../http/assets'
import { routeShape } from '../../http/path'
import { writeBuildAssets } from './assets'
import { type DiscoveredAppExports, discoverJobsDeclaration } from './discover/app'
import type { DiscoveredPageTree } from './discover/pages'
import type { DiscoveredRouteFile } from './discover/routes'

function writeFileIfChanged(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8')
    if (existing === content) return
  }
  writeFileSync(filePath, content, 'utf-8')
}

/** Creates a quoted relative module specifier for static and dynamic generated imports. */
function moduleSpecifier(generatedDir: string, filePath: string): string {
  const path = relative(generatedDir, filePath)
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '')
  return JSON.stringify(path.startsWith('.') ? path : `./${path}`)
}

/** Options controlling build artifact generation. */
interface GenerateOptions {
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
  assets?: BuildAssets
  /** Module exporting an external Api type, already relative to generated code when local. */
  apiTypes?: string
}

function generateClientTsx(
  pages: DiscoveredPageTree,
  generatedDir: string,
  webPrefix: string,
  apiPrefix: string,
): string {
  const imports: string[] = [
    `import '@vitejs/plugin-react/preamble'`,
    `import { hydratePageApplication, type ClientRoute } from '@olivaw/sark/runtime/page-browser'`,
    `import { notFound } from '@olivaw/sark/page'`,
  ]

  let rootLoadCode = ''
  if (pages.rootDocument) {
    rootLoadCode = `\n    rootLoad: () => import(${moduleSpecifier(generatedDir, pages.rootDocument.filePath)}),`
  }

  const clientRouteEntries: string[] = []

  for (const page of pages.pages) {
    const scopesCode: string[] = []

    for (const layout of page.layoutChain) {
      let errorLoadCode = ''
      if (layout.closestError) {
        errorLoadCode = `\n        errorLoad: () => import(${moduleSpecifier(generatedDir, layout.closestError.filePath)}),`
      }

      scopesCode.push(`      {
        id: ${JSON.stringify(`layout:${layout.scopeKey}`)},
        load: () => import(${moduleSpecifier(generatedDir, layout.filePath)}),${errorLoadCode}
      }`)
    }

    let pageErrorLoadCode = ''
    if (page.closestError) {
      pageErrorLoadCode = `\n        errorLoad: () => import(${moduleSpecifier(generatedDir, page.closestError.filePath)}),`
    }

    scopesCode.push(`      {
        id: ${JSON.stringify(`page:${page.scopeId}`)},
        load: () => import(${moduleSpecifier(generatedDir, page.filePath)}),${pageErrorLoadCode}
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
  clientRouteEntries.push(`  {
    pattern: ${JSON.stringify(webPrefix === '/' ? '/*' : `${webPrefix}/*`)},
    shapeKey: 'not-found',
    paramNames: [],${rootLoadCode}
    scopes: [{
      id: 'not-found', component: () => null,
      loader: () => notFound('Page Not Found'),
      ${rootError ? `errorLoad: () => import(${moduleSpecifier(generatedDir, rootError.filePath)}),` : ''}
    }],
  }`)

  return `${imports.join('\n')}

const routes = [
${clientRouteEntries.join(',\n')}
] satisfies readonly ClientRoute[]

hydratePageApplication(routes, ${JSON.stringify(apiPrefix)})
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
  const hasApp = appExports.exports.includes('app')
  const hasRuntime = appExports.exports.includes('runtime')
  const hasMfa = appExports.exports.includes('mfa')
  const hasTotp = appExports.exports.includes('totp')
  const hasWebAuthn = appExports.exports.includes('webauthn')
  const hasJobs = appExports.exports.includes('jobs')
  const requiresMfaAssembly = hasMfa || hasTotp || hasWebAuthn
  const hasAuth = appExports.exports.includes('auth')
  if (requiresMfaAssembly && !hasAuth)
    throw new Error('TOTP, WebAuthn and MFA require an auth session declaration.')
  if (hasMfa && !hasTotp && !hasWebAuthn)
    throw new Error('MFA requires at least one configured factor.')
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
    if (requiresMfaAssembly && !hasMfa) {
      throw new Error(
        'Cloudflare Workers target requires explicit MFA configuration ("mfa") with a shared AuthStateStore declaration (such as sqlAuthState from @olivaw/sark/auth/state/d1).',
      )
    }
    if (hasRuntime) {
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
        'Cloudflare Workers target does not support Node Prometheus metrics ("metrics"). Use Cloudflare platform analytics.',
      )
    }
    if (appExports.exports.includes('assets')) {
      throw new Error(
        'Cloudflare Workers target does not support Node asset mounts ("assets"). Use static assets or R2 object storage.',
      )
    }
    if (appExports.databaseDriver === 'sqlite' || appExports.databaseDriver === 'postgres') {
      throw new Error(
        `Cloudflare Workers target does not support Node.js database driver ("${appExports.databaseDriver}"). Use Cloudflare D1 ("@olivaw/sark/db/d1") for Workers.`,
      )
    }

    const discoveredJobs = hasJobs ? discoverJobsDeclaration(appEntryPath) : undefined
    if (discoveredJobs?.kind === 'static') {
      for (const job of discoveredJobs.jobs) {
        if (job.hasNodeOptions)
          throw new Error(
            `Job "${job.name}" declares Node-specific options not supported on Cloudflare Workers. Use onCron for Workers.`,
          )
        if (!job.onCron && !job.isDynamicOnCron)
          throw new Error(`Job "${job.name}" must specify onCron on Cloudflare Workers.`)
      }
    }
  } else if (target === 'node') {
    if (appExports.databaseDriver === 'd1') {
      throw new Error(
        'Node.js target does not support Cloudflare D1 database driver. Use SQLite ("@olivaw/sark/db/sqlite") or PostgreSQL ("@olivaw/sark/db/postgres") for Node.js.',
      )
    }
  }

  // 1. Generate app.ts
  const appImportPath = moduleSpecifier(generatedDir, appEntryPath)

  // Collect unique middleware files across routes
  const middlewareImports: string[] = []
  const middlewareVarMap = new Map<string, string>()

  for (const r of routes) {
    for (const mw of r.ancestorMiddlewares) {
      if (!middlewareVarMap.has(mw.filePath)) {
        const varName = `middleware_${middlewareVarMap.size}`
        middlewareVarMap.set(mw.filePath, varName)
        middlewareImports.push(
          `import * as ${varName} from ${moduleSpecifier(generatedDir, mw.filePath)}`,
        )
      }
    }
  }

  const routeImports: string[] = []
  const routeEntries: string[] = []
  const routeApiEntries: string[] = []

  // Group routes by URL path for Api type mapping
  const pathMethodMap = new Map<
    string,
    Array<{ method: string; importName: string; isSse: boolean; isWs: boolean }>
  >()

  routes.forEach((r, idx) => {
    const importName = `route_${idx}`
    routeImports.push(`import ${importName} from ${moduleSpecifier(generatedDir, r.filePath)}`)

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
    methods.push({
      method: r.routePath.method,
      importName,
      isSse: r.routePath.isSse,
      isWs: r.routePath.isWs,
    })
  })

  for (const [urlPath, methods] of pathMethodMap.entries()) {
    const methodLines: string[] = []
    for (const m of methods) {
      if (m.isSse) {
        methodLines.push(
          `    SSE: SseEndpointFromRoute<typeof ${m.importName}, ${JSON.stringify(urlPath)}>`,
        )
        methodLines.push(
          `    HEAD: { input: SseEndpointFromRoute<typeof ${m.importName}, ${JSON.stringify(urlPath)}>['input']; output: Response }`,
        )
      } else if (m.isWs) {
        methodLines.push(
          `    WS: WsEndpointFromRoute<typeof ${m.importName}, ${JSON.stringify(urlPath)}>`,
        )
      } else {
        methodLines.push(
          `    ${m.method}: EndpointFromRoute<typeof ${m.importName}, ${JSON.stringify(urlPath)}>`,
        )
        if (m.method === 'GET') {
          methodLines.push(
            `    HEAD: { input: EndpointFromRoute<typeof ${m.importName}, ${JSON.stringify(urlPath)}>['input']; output: Response }`,
          )
        }
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
      `import { createPageHandler, createPage404Handler, createPageConfigResolver, resolveClientAssets, type ServerPageRoute } from '@olivaw/sark/runtime/page-server'`,
    )

    const pageModuleMap = new Map<string, string>()
    function getPageImport(filePath: string, prefix: string): string {
      let name = pageModuleMap.get(filePath)
      if (!name) {
        name = `${prefix}_${pageModuleMap.size}`
        pageModuleMap.set(filePath, name)
        pageImports.push(`import * as ${name} from ${moduleSpecifier(generatedDir, filePath)}`)
      }
      return name
    }

    let rootComponentCode = 'undefined'
    if (pages.rootDocument) {
      rootComponentCode = `${getPageImport(pages.rootDocument.filePath, 'root')}.default`
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
      source: ${JSON.stringify(page.relativePath)},
      routePath: ${JSON.stringify(routePath)},
      scopes: pageRoutes[${index}].httpScopes,
      pageHandler: createPageHandler(pageRoutes[${index}], () => resolveClientAssets(buildAssets, pageRoutes[${index}].pattern)),
    },`)
    })
    const rootError = pages.errors.get('')
    const errorCode = rootError
      ? `${getPageImport(rootError.filePath, 'root_error')}.default`
      : 'undefined'
    pageHandlerCode = `
const pageRoutes = [
${pageRoutesCode.join(',\n')}
] satisfies readonly ServerPageRoute[]

const page404Handler = createPage404Handler(
  ${rootComponentCode},
  ${errorCode},
  () => resolveClientAssets(buildAssets, '/*'),
)
`
  }

  const hasDatabase = appExports.exports.includes('database')
  const hasStorage = appExports.exports.includes('storage')
  const hasAssets = appExports.exports.includes('assets')
  const hasOAuth = appExports.exports.includes('oauth')
  const hasFeeds = appExports.exports.includes('feeds')
  const hasVisitors = appExports.exports.includes('visitors')
  const hasHealth = appExports.exports.includes('health')
  const hasLogging = appExports.exports.includes('logging')
  const hasRateLimit = appExports.exports.includes('rateLimit')
  const hasPageCache = appExports.exports.includes('pageCache')
  const hasMetrics = appExports.exports.includes('metrics')
  const hasStats = appExports.exports.includes('stats')

  const runtimeImports: string[] = []
  const appBindings = new Set<string>()
  const preparationCode: string[] = []
  const definitionFields: string[] = []
  const resourceEntries: string[] = []
  const resourceTypeImports: string[] = []
  const resourceTypeAliases: string[] = []
  const resourceTypeFields: string[] = []
  const serviceEntries: string[] = []
  const serviceTypeImports: string[] = []
  const serviceTypeFields: string[] = []
  const declItems: string[] = []
  const factors: string[] = []
  const proofs: string[] = []
  if (hasApp) {
    appBindings.add('app')
    definitionFields.push('app,')
  }
  if (hasRuntime) {
    appBindings.add('runtime')
    declItems.push('runtime')
  }
  if (appExports.exports.includes('page')) {
    appBindings.add('page')
    definitionFields.push('page,')
  }
  if (hasDatabase) {
    appBindings.add('database')
    resourceEntries.push('db: database')
    resourceTypeImports.push(`import type { database } from ${appImportPath}`)
    resourceTypeAliases.push('export type Db = InferResource<typeof database>')
    resourceTypeFields.push('  readonly db: Db')
  }
  if (hasStorage) {
    appBindings.add('storage')
    runtimeImports.push("import { createStorageAssembly } from '@olivaw/sark/runtime/storage'")
    resourceEntries.push('storage: createStorageAssembly(storage)')
    resourceTypeImports.push(`import type { storage } from ${appImportPath}`)
    resourceTypeAliases.push(
      'export type Storage = { [K in keyof typeof storage]: InferResource<(typeof storage)[K]> }',
    )
    resourceTypeFields.push('  readonly storage: Storage')
  }
  if (hasAssets) {
    appBindings.add('assets')
    definitionFields.push('assetMounts: assets,')
  }
  if (hasAuth) {
    appBindings.add('auth')
    runtimeImports.push("import { createAuthAssembly } from '@olivaw/sark/runtime/auth'")
    serviceEntries.push('auth: createAuthAssembly(auth)')
    serviceTypeImports.push("import type { RequestAuth } from '@olivaw/sark/auth'")
    serviceTypeFields.push('  readonly auth: RequestAuth')
  }
  if (hasOAuth) {
    appBindings.add('oauth')
    runtimeImports.push("import { createOAuthAssembly } from '@olivaw/sark/runtime/oauth'")
    serviceEntries.push(`oauth: createOAuthAssembly(oauth, ${JSON.stringify(apiPrefix)})`)
  }
  if (hasFeeds) {
    appBindings.add('feeds')
    runtimeImports.push("import { createFeedsAssembly } from '@olivaw/sark/runtime/feeds'")
    serviceEntries.push('feeds: createFeedsAssembly(feeds)')
  }
  if (hasVisitors) {
    appBindings.add('visitors')
    runtimeImports.push("import { createVisitorsAssembly } from '@olivaw/sark/runtime/visitors'")
    serviceEntries.push('visitors: createVisitorsAssembly(visitors)')
    serviceTypeImports.push("import type { RequestVisitor } from '@olivaw/sark/visitors'")
    serviceTypeFields.push('  readonly visitor: RequestVisitor')
  }
  if (hasMfa) {
    appBindings.add('mfa')
    declItems.push('mfa')
  }
  if (hasTotp) {
    appBindings.add('totp')
    declItems.push('totp')
    runtimeImports.push("import { createTotpFactor } from '@olivaw/sark/runtime/totp'")
    preparationCode.push('const totpFactor = createTotpFactor(totp)')
    factors.push('totpFactor')
    proofs.push("{ kind: 'totp'; code: string }")
    serviceTypeImports.push("import type { RequestTotp } from '@olivaw/sark/auth/totp'")
    serviceTypeFields.push('  readonly totp: RequestTotp')
  }
  if (hasWebAuthn) {
    appBindings.add('webauthn')
    declItems.push('webauthn')
    runtimeImports.push("import { createWebAuthnFactor } from '@olivaw/sark/runtime/webauthn'")
    factors.push('createWebAuthnFactor(webauthn)')
    proofs.push("{ kind: 'webauthn'; response: AuthenticationResponseJSON }")
    serviceTypeImports.push(
      "import type { RequestWebAuthn, AuthenticationResponseJSON } from '@olivaw/sark/auth/webauthn'",
    )
    serviceTypeFields.push('  readonly webauthn: RequestWebAuthn')
  }
  // Fixed generated order is the dependency contract: session, factors, then maintenance.
  if (requiresMfaAssembly) {
    runtimeImports.push("import { createMfaAssembly } from '@olivaw/sark/runtime/mfa'")
    serviceEntries.push(
      `mfa: createMfaAssembly({ ${hasMfa ? 'mfa, ' : ''}factors: [${factors.join(', ')}] })`,
    )
    proofs.push("{ kind: 'recovery'; code: string }")
    serviceTypeImports.push("import type { RequestMfa } from '@olivaw/sark/auth/mfa'")
    serviceTypeFields.push(`  readonly mfa: RequestMfa<${proofs.join(' | ')}>`)
  }
  if (hasTotp) serviceEntries.push('totp: totpFactor.maintenance')
  if (hasHealth) {
    appBindings.add('health')
    declItems.push('health')
    runtimeImports.push("import { createHealthAssembly } from '@olivaw/sark/runtime/health'")
    definitionFields.push('health: createHealthAssembly(health),')
  }
  if (hasLogging) {
    appBindings.add('logging')
    declItems.push('logging')
    runtimeImports.push("import { createLoggingAssembly } from '@olivaw/sark/runtime/logging'")
    definitionFields.push('logging: createLoggingAssembly(logging),')
  }
  if (hasRateLimit) {
    appBindings.add('rateLimit')
    declItems.push('rateLimit')
    runtimeImports.push("import { createRateLimitAssembly } from '@olivaw/sark/runtime/rate-limit'")
    definitionFields.push('admission: createRateLimitAssembly(rateLimit),')
  }
  if (hasPageCache) {
    appBindings.add('pageCache')
    declItems.push('pageCache')
    runtimeImports.push("import { createPageCacheAssembly } from '@olivaw/sark/runtime/page-cache'")
    serviceEntries.push('cache: createPageCacheAssembly(pageCache)')
    serviceTypeImports.push("import type { PageCacheService } from '@olivaw/sark/page/cache'")
    serviceTypeFields.push('  readonly cache: PageCacheService')
  }
  if (hasMetrics) {
    appBindings.add('metrics')
    declItems.push('metrics')
    runtimeImports.push("import { createMetricsAssembly } from '@olivaw/sark/runtime/metrics'")
    serviceEntries.push('metrics: createMetricsAssembly(metrics)')
    serviceTypeImports.push("import type { MetricsService } from '@olivaw/sark/node'")
    serviceTypeFields.push('  readonly metrics: MetricsService')
  }
  if (hasStats) {
    appBindings.add('stats')
    declItems.push('stats')
    runtimeImports.push("import { createStatsAssembly } from '@olivaw/sark/runtime/stats'")
    serviceEntries.push(
      `stats: createStatsAssembly(stats, { visitors: ${hasVisitors}, auth: ${hasAuth} })`,
    )
    serviceTypeImports.push(
      "import type { ScopedStatsService, InferStatsCounters } from '@olivaw/sark/stats'",
    )
    serviceTypeImports.push("import type { stats } from '../app'")
    serviceTypeFields.push('  readonly stats: ScopedStatsService<InferStatsCounters<typeof stats>>')
  }
  if (hasJobs) {
    appBindings.add('jobs')
    declItems.push('jobs')
    if (target === 'node') {
      runtimeImports.push("import { createNodeJobsAssembly } from '@olivaw/sark/runtime/jobs-node'")
      serviceEntries.push('jobs: createNodeJobsAssembly(jobs)')
    } else {
      runtimeImports.push(
        "import { createCloudflareJobsHandler } from '@olivaw/sark/runtime/jobs-cloudflare'",
      )
      definitionFields.push('scheduled: createCloudflareJobsHandler(jobs),')
    }
  }
  const resourcesCode = resourceEntries.length
    ? `resources: { ${resourceEntries.join(', ')} },`
    : ''
  const servicesCode = serviceEntries.length ? `services: { ${serviceEntries.join(', ')} },` : ''
  const declarationsCode = declItems.length
    ? `declarations: [${declItems.join(', ')}] as const,`
    : ''

  const appTsContent = `import { createDefinition } from '@olivaw/sark/runtime/core'
${runtimeImports.join('\n')}
import type { EndpointFromRoute, SseEndpointFromRoute, WsEndpointFromRoute } from '@olivaw/sark'
${options.apiTypes ? `import type { Api as ExternalApi } from ${JSON.stringify(options.apiTypes)}` : ''}
${appBindings.size ? `import { ${[...appBindings].join(', ')} } from ${appImportPath}` : ''}
${middlewareImports.join('\n')}
${routeImports.join('\n')}
${pageImports.join('\n')}
${hasPages || (target === 'node' && options.assets) ? "import { buildAssets } from './build-assets'" : ''}

${pageHandlerCode}
${preparationCode.join('\n')}

export const definition = createDefinition({
  ${definitionFields.join('\n  ')}
  ${declarationsCode}
  ${resourcesCode}
  ${servicesCode}
  apiPrefix: ${JSON.stringify(apiPrefix)},
  webPrefix: ${JSON.stringify(webPrefix)},
  routes: [
${routeEntries.join('\n')}
${pageEntriesCode.join('\n')}
  ],
  ${hasPages ? 'page404Handler,' : ''}
  ${hasPages ? `createPageConfigResolver: () => createPageConfigResolver(${appExports.exports.includes('page') ? 'page' : 'undefined'}, ${JSON.stringify(apiPrefix)}),` : ''}
  ${target === 'node' && options.assets ? 'assets: buildAssets,' : ''}
})

${hasRuntime ? `export { runtime } from ${appImportPath}` : 'export const runtime = undefined'}

export type AppDefinition = typeof definition
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
    writeBuildAssets({ generatedDir, target }, options.assets)
  }

  // 2. Generate resources-types.ts
  const resourcesTypesContent = `// Generated resource types
${resourceTypeImports.join('\n')}
import type { InferResource } from '@olivaw/sark/runtime/core'

${resourceTypeAliases.join('\n')}

export interface Resources {
${resourceTypeFields.join('\n')}
}
`
  writeFileIfChanged(join(generatedDir, 'resources-types.ts'), resourcesTypesContent)

  // 3. Generate services-types.ts
  const servicesTypesContent = `// Generated services types
${serviceTypeImports.length > 0 ? `${serviceTypeImports.join('\n')}\n\n` : ''}export interface Services {
${serviceTypeFields.join('\n')}
}
`
  writeFileIfChanged(join(generatedDir, 'services-types.ts'), servicesTypesContent)

  // 4. Generate types.d.ts with Register module augmentations
  const typesDtsContent = `// Generated type registrations
import '@olivaw/sark/client'
import type { Api } from './app'
import type { Resources } from './resources-types'
import type { Services } from './services-types'

declare module '@olivaw/sark/client' {
  interface Register {
    api: Api
  }
}

declare module '@olivaw/sark' {
  interface Register {
    resources: Resources
    services: Services
  }
}
export type { AppDefinition, Api } from './app'
export type { Resources } from './resources-types'
export type { Services } from './services-types'
${hasDatabase ? "export type { Db } from './resources-types'" : ''}
${hasStorage ? "export type { Storage } from './resources-types'" : ''}
${hasAuth ? "export type { RequestAuth } from '@olivaw/sark/auth'" : ''}
${hasVisitors ? "export type { RequestVisitor } from '@olivaw/sark/visitors'" : ''}
${hasPageCache ? "export type { PageCacheService } from '@olivaw/sark/page/cache'" : ''}
${hasMetrics ? "export type { MetricsService } from '@olivaw/sark/node'" : ''}
${hasStats ? "export type { ScopedStatsService, StatsService } from '@olivaw/sark/stats'" : ''}
`
  writeFileIfChanged(join(generatedDir, 'types.d.ts'), typesDtsContent)

  // 5. Generate client.tsx if pages exist, or clean up if none
  if (hasPages && pages) {
    writeFileIfChanged(
      join(generatedDir, 'client.tsx'),
      generateClientTsx(pages, generatedDir, webPrefix, apiPrefix),
    )
  } else {
    rmSync(join(generatedDir, 'client.tsx'), { force: true })
  }

  // 6. Generate runtime-specific entrypoint
  if (target === 'node') {
    rmSync(join(generatedDir, 'worker.ts'), { force: true })
    const startTsContent = `import { createApp } from '@olivaw/sark'
import { loadNodeEnv, prepareNodeRuntime, listenNodeServer } from '@olivaw/sark/runtime/node'
${options.assets ? "import { fileURLToPath } from 'node:url'" : ''}
${options.assets ? "import { dirname } from 'node:path'" : ''}

loadNodeEnv()

// Dynamic import after environment initialization
const { definition, runtime } = await import('./app')
const host = prepareNodeRuntime(definition, runtime, process.env)
const instance = await createApp(definition, { env: process.env })
await listenNodeServer(instance, host${options.assets ? ', { rootDir: dirname(fileURLToPath(import.meta.url)), assets: definition.assets! }' : ''})
`
    writeFileIfChanged(join(generatedDir, 'start.ts'), startTsContent)
  } else if (target === 'cloudflare') {
    rmSync(join(generatedDir, 'start.ts'), { force: true })
    const workerTsContent = `/// <reference types="vite/client" />
import { createWorkerHandler, type CloudflareExecutionContext${hasJobs ? ', type ScheduledController' : ''} } from '@olivaw/sark/runtime/cloudflare'
import { definition } from './app'

declare global {
  interface Env {}
}

declare module '@olivaw/sark' {
  interface Register {
    env: Env
  }
}

const handler = createWorkerHandler(definition, import.meta.env.PROD)

export default {
  fetch(request: Request, env: Env, ctx: CloudflareExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx)
  },${hasJobs ? `\n  scheduled(controller: ScheduledController, env: Env, ctx: CloudflareExecutionContext): Promise<void> {\n    return handler.scheduled!(controller, env, ctx)\n  },` : ''}
}
`
    writeFileIfChanged(join(generatedDir, 'worker.ts'), workerTsContent)
  }
}
