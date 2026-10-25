/**
 * Node environment file loading before application declarations are imported.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * Loads cascading environment files into `process.env` or a target dictionary.
 *
 * Evaluation order (later files override earlier ones):
 * 1. `.env`
 * 2. `.env.local`
 * 3. `.env.${NODE_ENV}`
 * 4. `.env.${NODE_ENV}.local`
 *
 * The mode is read from env.NODE_ENV before loading files, defaulting to production.
 * Existing values in env take precedence over all files. Missing files are skipped;
 * env.NODE_ENV is set to production if it remains undefined after loading.
 *
 * @param root - Directory containing environment files (defaults to `process.cwd()`).
 * @param env - Target environment object to populate (defaults to `process.env`).
 * @throws {Error} If an existing environment file cannot be read or parsed.
 */
export function loadNodeEnv(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const mode = env.NODE_ENV ?? 'production'
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
  for (const [key, value] of Object.entries(loaded)) {
    if (env[key] === undefined) env[key] = value
  }
  env.NODE_ENV ??= 'production'
}
