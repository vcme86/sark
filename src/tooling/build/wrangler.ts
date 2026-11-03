/**
 * Cloudflare Wrangler configuration resolution delegating to upstream wrangler unstable_readConfig.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

import type { unstable_readConfig as ReadConfig } from 'wrangler'

export interface EffectiveWranglerTriggers {
  readonly crons?: readonly string[]
}

/**
 * Resolves effective triggers.crons from the project's Wrangler configuration using upstream Wrangler API.
 * Supports custom configuration path, CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH, and CLOUDFLARE_ENV.
 *
 * @param root - Project root directory.
 * @param configPath - Explicit configuration file path.
 * @param envName - Target Cloudflare environment name.
 * @returns Resolved triggers or undefined if no Wrangler configuration or triggers found.
 */
export function resolveEffectiveWranglerTriggers(
  root: string,
  configPath?: string,
  envName = process.env.CLOUDFLARE_ENV,
): EffectiveWranglerTriggers | undefined {
  const envPath = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
  const targetConfig = configPath ?? envPath

  let resolvedConfigPath: string | undefined
  if (targetConfig) {
    resolvedConfigPath = isAbsolute(targetConfig) ? targetConfig : join(root, targetConfig)
  } else {
    const candidates = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
    for (const candidate of candidates) {
      const full = join(root, candidate)
      if (existsSync(full)) {
        resolvedConfigPath = full
        break
      }
    }
  }

  if (!resolvedConfigPath) return undefined
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`Wrangler configuration file does not exist: ${resolvedConfigPath}`)
  }

  // Node-only tooling must not load the optional Workers SDK.
  const { unstable_readConfig } = createRequire(import.meta.url)('wrangler') as {
    unstable_readConfig: typeof ReadConfig
  }

  const config = unstable_readConfig({
    config: resolvedConfigPath,
    env: envName,
  })

  if (config.triggers?.crons !== undefined) {
    return {
      crons: config.triggers.crons,
    }
  }

  return undefined
}
