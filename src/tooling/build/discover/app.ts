/**
 * Static discovery of named application configuration exports.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'

import { parseSync } from 'vite'

/** Summary of configuration exports discovered from the application entrypoint file. */
export interface DiscoveredAppExports {
  /** Indicates whether an `app` configuration declaration was found. */
  hasApp: boolean
  /** Indicates whether a `runtime` platform declaration was found. */
  hasRuntime: boolean
  /** List of all recognized configuration export names. */
  exports: string[]
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

/**
 * Discovers named configuration exports without evaluating application code.
 *
 * Discovery rules:
 * - A missing entry file produces empty export metadata.
 * - Type-only exports are ignored.
 * - Default exports and wildcard value re-exports are rejected.
 * - Discovered value export names must belong to the supported configuration set.
 *
 * @param appFilePath - Absolute path to `app.ts` or target file.
 * @returns Discovered export metadata.
 * @throws {Error} If parsing fails or an invalid export construct is encountered.
 */
export function discoverAppEntry(appFilePath: string): DiscoveredAppExports {
  if (!existsSync(appFilePath)) {
    return { hasApp: false, hasRuntime: false, exports: [] }
  }

  const sourceText = readFileSync(appFilePath, 'utf-8')
  const parseResult = parseSync(appFilePath, sourceText)

  if (parseResult.errors && parseResult.errors.length > 0) {
    throw new Error(
      `Failed to parse app entry ${appFilePath}: ${parseResult.errors.map((e: any) => e.message || String(e)).join(', ')}`,
    )
  }

  const foundExports: string[] = []
  const program = parseResult.program

  for (const node of program.body) {
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
    hasApp: foundExports.includes('app'),
    hasRuntime: foundExports.includes('runtime'),
    exports: foundExports,
  }
}
