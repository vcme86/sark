/**
 * Application assembly code generation, type registrations, and runtime start scripts.
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

function writeFileIfChanged(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8')
    if (existing === content) return
  }
  writeFileSync(filePath, content, 'utf-8')
}

import type { DiscoveredAppExports } from '../discover/app'
import type { DiscoveredRouteFile } from '../discover/routes'

/** Options controlling build artifact generation. */
export interface GenerateOptions {
  /** Target output directory (typically `.build`). */
  generatedDir: string
  /** Absolute path to the user's `app.ts` file. */
  appEntryPath: string
  /** Discovered named exports from `app.ts`. */
  appExports: DiscoveredAppExports
  /** Discovered API route files. */
  routes: DiscoveredRouteFile[]
  /** Resolved API path prefix removed from generated client route keys. */
  apiPrefix: string
  /** Resolved target platform for Node or Workers startup generation. */
  target: 'node' | 'cloudflare'
}

/**
 * Writes application assembly and type declarations, plus a startup entry for Node or Workers.
 *
 * @param options - Output directory, discovered exports/routes, API prefix, and deployment target.
 * @throws If a declaration is incompatible with the target or output files cannot be written.
 */
export function generateBuildArtifacts(options: GenerateOptions): void {
  const { generatedDir, appEntryPath, appExports, routes, apiPrefix, target } = options
  mkdirSync(generatedDir, { recursive: true })

  if (target !== 'node') {
    throw new Error('Cloudflare Workers target requires the Workers runtime integration.')
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

  const appTsContent = `import type { Hono } from 'hono'
import { createDefinition } from '@olivaw/sark/runtime/core'
import type { EndpointFromRoute } from '@olivaw/sark/server'
${appExports.hasApp ? `import { app } from '${appImportPath}'` : ''}
${appExports.hasRuntime ? `import { runtime } from '${appImportPath}'` : ''}
${middlewareImports.join('\n')}
${routeImports.join('\n')}

export const definition = createDefinition({
  ${appExports.hasApp ? 'app,' : ''}
  ${appExports.hasRuntime ? 'declarations: [runtime] as const,' : ''}
  routes: [
${routeEntries.join('\n')}
  ],
})

${appExports.hasRuntime ? `export { runtime } from '${appImportPath}'` : 'export const runtime = undefined'}

export type AppDefinition = typeof definition
export type App = Hono<any>
export type Api = {
${routeApiEntries.join('\n')}
}
`
  writeFileIfChanged(join(generatedDir, 'app.ts'), appTsContent)

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

  // 5. Generate runtime-specific entrypoint
  if (target === 'node') {
    rmSync(join(generatedDir, 'worker.ts'), { force: true })
    const startTsContent = `import { createApp } from '@olivaw/sark/server'
import { loadNodeEnv, startNodeServer } from '@olivaw/sark/runtime/node'

loadNodeEnv()

// Dynamic import after environment initialization
const { definition, runtime } = await import('./app')
const instance = await createApp(definition, { env: process.env })
await startNodeServer(instance, runtime, process.env)
`
    writeFileIfChanged(join(generatedDir, 'start.ts'), startTsContent)
  }
}
