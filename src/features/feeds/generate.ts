/** Format dispatch to native Feedsmith generators. */
import * as Feedsmith from 'feedsmith'

import type { FeedData, ResolvedFeedConfig } from './types'

/**
 * Generates a subscription document from the endpoint loader's native format data.
 *
 * @param config - Resolved endpoint policy and native generator options.
 * @param content - Result of this endpoint's load callback.
 * @returns The XML or JSON response body.
 * @throws If native generation or JSON serialization fails.
 */
export function generateFeed(
  config: ResolvedFeedConfig,
  content: FeedData[keyof FeedData],
): string {
  switch (config.format) {
    case 'rss':
      return Feedsmith.generateRssFeed(content as FeedData['rss'], {
        ...config.options,
        strict: true,
      })
    case 'atom':
      return Feedsmith.generateAtomFeed(content as FeedData['atom'], {
        ...config.options,
        strict: true,
      })
    case 'json':
      return JSON.stringify(
        Feedsmith.generateJsonFeed(content as FeedData['json'], {
          ...config.options,
          strict: true,
        }),
      )
    case 'opml':
      return Feedsmith.generateOpml(content as FeedData['opml'], {
        ...config.options,
        strict: true,
      })
  }
}
