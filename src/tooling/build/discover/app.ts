/**
 * Static discovery of named application configuration exports.
 *
 * @module
 */

import { existsSync } from 'node:fs'

import { parseModule } from './module'

/** Summary of configuration exports discovered from the application entrypoint file. */
export interface DiscoveredAppExports {
  /** List of all recognized configuration export names. */
  exports: string[]
  /** Detected database driver if declared using an official driver entrypoint. */
  databaseDriver?: 'sqlite' | 'postgres' | 'd1'
}

const ALLOWED_EXPORTS = new Set([
  'app',
  'runtime',
  'page',
  'database',
  'storage',
  'assets',
  'auth',
  'oauth',
  'totp',
  'webauthn',
  'mfa',
  'visitors',
  'stats',
  'jobs',
  'rateLimit',
  'pageCache',
  'logging',
  'metrics',
  'health',
])

/** Module resolution supplied by Vite under the server target's conditions. */
type ResolveModule = (specifier: string, importer: string) => Promise<string | undefined>

type Program = ReturnType<typeof parseModule>
type Statement = Program['body'][number]
type Initializer = Extract<
  Statement,
  { type: 'VariableDeclaration' }
>['declarations'][number]['init']
type Driver = NonNullable<DiscoveredAppExports['databaseDriver']>
type SymbolOrigin =
  | { kind: 'constructor' | 'database'; driver: Driver }
  | { kind: 'namespace'; source: string; importer: string }
type Reference = { source: string; imported: string } | { local: string }

/**
 * Follows the selected declaration's explicit bindings without evaluating application code.
 * File extensions, aliases, package exports and target conditions are resolved by Vite.
 *
 * @param entry - Application entry file.
 * @param resolveModule - Target-aware Vite resolver.
 * @returns The selected official driver, or undefined for an unknown configuration expression.
 */
export async function discoverDatabaseDriver(
  entry: string,
  resolveModule: ResolveModule,
): Promise<Driver | undefined> {
  const modules = new Map<
    string,
    {
      imports: Map<string, Reference>
      locals: Map<string, Initializer>
      exports: Map<string, Reference>
    }
  >()
  const active = new Set<string>()

  function getModule(file: string) {
    const cached = modules.get(file)
    if (cached) return cached
    const module = {
      imports: new Map<string, Reference>(),
      locals: new Map<string, Initializer>(),
      exports: new Map<string, Reference>(),
    }
    for (const node of parseModule(file).body) {
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            module.imports.set(specifier.local.name, { source: node.source.value, imported: '*' })
            continue
          }
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue
          const imported =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value
          module.imports.set(specifier.local.name, { source: node.source.value, imported })
        }
      }
      const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node
      if (declaration?.type === 'VariableDeclaration') {
        for (const variable of declaration.declarations) {
          if (variable.id.type !== 'Identifier') continue
          module.locals.set(variable.id.name, variable.init)
          if (node.type === 'ExportNamedDeclaration')
            module.exports.set(variable.id.name, { local: variable.id.name })
        }
      }
      if (node.type === 'ExportAllDeclaration' && node.exported && node.exportKind !== 'type') {
        module.exports.set(
          node.exported.type === 'Identifier' ? node.exported.name : node.exported.value,
          { source: node.source.value, imported: '*' },
        )
      }
      if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type') continue
        const exported =
          specifier.exported.type === 'Identifier'
            ? specifier.exported.name
            : specifier.exported.value
        const local =
          specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value
        module.exports.set(
          exported,
          node.source ? { source: node.source.value, imported: local } : { local },
        )
      }
    }
    modules.set(file, module)
    return module
  }

  async function followReference(
    file: string,
    reference: Reference,
  ): Promise<SymbolOrigin | undefined> {
    if ('local' in reference) return follow(file, reference.local, false)
    if (reference.imported === '*') {
      return { kind: 'namespace', source: reference.source, importer: file }
    }
    const match = /^@olivaw\/sark\/db\/(sqlite|postgres|d1)$/.exec(reference.source)
    if (match) {
      return reference.imported === 'defineDatabase'
        ? { kind: 'constructor', driver: match[1] as Driver }
        : undefined
    }
    const resolved = await resolveModule(reference.source, file)
    if (!resolved) return undefined
    if (resolved.startsWith('\0'))
      throw new Error(`Virtual configuration module is not supported: ${reference.source}`)
    return follow(resolved, reference.imported, true)
  }

  async function expression(
    file: string,
    node: Initializer | undefined,
  ): Promise<SymbolOrigin | undefined> {
    if (!node) return undefined
    if (node.type === 'Identifier') return follow(file, node.name, false)
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression'
    )
      return expression(file, node.expression)
    if (node.type === 'MemberExpression') {
      const property =
        !node.computed && node.property.type === 'Identifier'
          ? node.property.name
          : node.computed &&
              node.property.type === 'Literal' &&
              typeof node.property.value === 'string'
            ? node.property.value
            : undefined
      if (property === undefined || node.object.type === 'Super') return undefined
      const origin = await expression(file, node.object)
      return origin?.kind === 'namespace'
        ? followReference(origin.importer, { source: origin.source, imported: property })
        : undefined
    }
    if (node.type !== 'CallExpression' || node.callee.type === 'Super') return undefined
    const origin = await expression(file, node.callee)
    return origin?.kind === 'constructor' ? { kind: 'database', driver: origin.driver } : undefined
  }

  async function follow(
    file: string,
    name: string,
    exported: boolean,
  ): Promise<SymbolOrigin | undefined> {
    const key = `${file}:${exported ? 'export' : 'local'}:${name}`
    if (active.has(key)) return undefined
    active.add(key)
    try {
      const module = getModule(file)
      const reference = exported ? module.exports.get(name) : module.imports.get(name)
      return reference
        ? await followReference(file, reference)
        : exported
          ? undefined
          : await expression(file, module.locals.get(name))
    } finally {
      active.delete(key)
    }
  }

  const origin = await follow(entry, 'database', true)
  return origin?.kind === 'database' ? origin.driver : undefined
}

/**
 * Discovers named configuration exports without evaluating application code.
 * Driver origins are resolved separately once Vite target configuration is available.
 *
 * @param appFilePath - Absolute path to `app.ts` or target file.
 * @returns Discovered export metadata.
 * @throws {Error} If parsing fails or an invalid export construct is encountered.
 */
export function discoverAppEntry(appFilePath: string): DiscoveredAppExports {
  if (!existsSync(appFilePath)) {
    return { exports: [] }
  }

  const foundExports: string[] = []

  for (const node of parseModule(appFilePath).body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.exportKind === 'type') continue
      if (node.declaration) {
        if (node.declaration.type === 'VariableDeclaration') {
          for (const decl of node.declaration.declarations) {
            if (decl.id.type === 'Identifier') {
              foundExports.push(decl.id.name)
            }
          }
        } else if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
          foundExports.push(node.declaration.id.name)
        }
      } else if (node.specifiers) {
        for (const spec of node.specifiers) {
          if (spec.type === 'ExportSpecifier' && spec.exportKind === 'type') continue
          if (spec.exported && spec.exported.type === 'Identifier') {
            foundExports.push(spec.exported.name)
          }
        }
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      throw new Error(
        `Invalid default export found in ${appFilePath}. Sark app entries only support named configuration exports.`,
      )
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exportKind === 'type') continue
      throw new Error(
        `Invalid "export *" found in ${appFilePath}. Sark app entries only support explicit named configuration exports.`,
      )
    }
  }

  // Validate named exports against allowed configurations
  for (const exp of foundExports) {
    if (!ALLOWED_EXPORTS.has(exp)) {
      throw new Error(
        `Unknown configuration export "${exp}" in ${appFilePath}. Only official configuration exports are allowed.`,
      )
    }
  }

  return {
    exports: foundExports,
  }
}
