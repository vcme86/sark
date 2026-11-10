/**
 * Node environment file loading before application declarations are imported.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * Reads server environment files using Node's dotenv syntax.
 *
 * Evaluation order (later files override earlier ones):
 * 1. `.env`
 * 2. `.env.local`
 * 3. `.env.${mode}`
 * 4. `.env.${mode}.local`
 *
 * Existing environment values take precedence over files. Missing files are skipped.
 *
 * @param root - Directory containing environment files.
 * @param mode - Selects the mode-specific environment files.
 * @param env - Environment values supplied by the host.
 * @returns Merged environment without modifying the supplied values.
 * @throws {Error} If an existing environment file cannot be read or parsed.
 */
export function readNodeEnv(
  root: string,
  mode: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const loaded: NodeJS.ProcessEnv = {}
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const path = resolve(root, name)
    try {
      Object.assign(loaded, parseEnv(readFileSync(path, 'utf8')))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw new Error(`Failed to load environment file ${path}`, { cause: error })
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) loaded[key] = value
  }
  return loaded
}

/** Loads the production entry's environment before importing the application. */
export function loadNodeEnv(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  Object.assign(env, readNodeEnv(root, 'production', env), { NODE_ENV: 'production' })
}
