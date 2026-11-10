/** Subscription declarations and configuration resolution. */
import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import { resolveStaticPath } from '../../http/url'
import type { FeedFormat, FeedsConfig, ResolvedFeedConfig } from './types'

const FORMATS: Record<FeedFormat, { path: string; contentType: string }> = {
  rss: { path: '/feed.xml', contentType: 'application/rss+xml' },
  atom: { path: '/feed.atom', contentType: 'application/atom+xml' },
  json: { path: '/feed.json', contentType: 'application/feed+json' },
  opml: { path: '/subscriptions.opml', contentType: 'text/x-opml' },
}

/** Declaration consumed by generated subscription assembly. */
export interface FeedsDeclaration extends BaseDeclaration<'feeds', FeedsConfig> {}

/**
 * Declares subscriptions configured for the owning instance or Workers event.
 *
 * @param factory - Receives the host environment and returns subscription configurations.
 * @returns A declaration preserving the required environment type.
 */
export function defineFeeds<E>(factory: (env: E) => FeedsConfig): FeedsDeclaration & RequiresEnv<E>

/**
 * Declares named content subscriptions from static settings.
 *
 * @param config - Static subscription configurations.
 * @returns A declaration selected by generated application assembly.
 */
export function defineFeeds(config: FeedsConfig): FeedsDeclaration

export function defineFeeds(input: FeedsConfig | ((env: any) => FeedsConfig)): FeedsDeclaration {
  return { kind: 'feeds', value: input, isFactory: typeof input === 'function' }
}

/**
 * Resolves complete publication settings before application resources are created.
 *
 * @param declaration - Static subscription settings or environment factory.
 * @param env - Environment supplied by the owning host.
 * @returns Subscriptions with validated formats, paths, and response headers.
 * @throws If the collection or an endpoint configuration is invalid.
 */
export function resolveFeedsConfig(
  declaration: FeedsDeclaration,
  env: unknown,
): readonly ResolvedFeedConfig[] {
  const input = evaluateDeclaration(declaration.value, env, 'feeds')
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length)
    throw new Error('Feeds configuration must be a non-empty named collection.')

  return Object.entries(input).map(([name, config]) => {
    if (!config || typeof config !== 'object' || typeof config.load !== 'function')
      throw new Error(`Feed "${name}" requires a load callback.`)
    if (!Object.hasOwn(FORMATS, config.format))
      throw new Error(`Feed "${name}" requires rss, atom, json, or opml format.`)
    const defaults = FORMATS[config.format]
    const path = resolveStaticPath(config.path ?? defaults.path, `Feed "${name}" path`)

    const headers = new Headers(config.headers)
    for (const field of [
      'content-type',
      'content-length',
      'content-encoding',
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ]) {
      if (headers.has(field)) throw new Error(`Feed "${name}" cannot set ${field}.`)
    }
    if (!headers.has('cache-control')) headers.set('cache-control', 'no-cache')
    headers.set('content-type', `${defaults.contentType}; charset=utf-8`)
    return { ...config, name, path, responseHeaders: headers }
  })
}
