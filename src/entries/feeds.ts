/** Optional subscription endpoints using native Feedsmith data and generator options. */
export { defineFeeds, type FeedsDeclaration } from '../features/feeds/config'
export type {
  FeedConfig,
  FeedData,
  FeedFormat,
  FeedOptions,
  FeedsConfig,
} from '../features/feeds/types'
export type { RssFeed, AtomFeed, JsonFeed, Opml } from 'feedsmith'
