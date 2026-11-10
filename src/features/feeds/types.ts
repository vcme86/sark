/** Native feed formats and configuration for optional subscription publication. */
import type * as Feedsmith from 'feedsmith'

import type { Context } from '../../app/http/types'

/** Data contracts supplied by Feedsmith, with specification-required fields enabled. */
export interface FeedData {
  readonly rss: Feedsmith.RssFeed.Feed<Date, true>
  readonly atom: Feedsmith.AtomFeed.Feed<Date, true>
  readonly json: Feedsmith.JsonFeed.Feed<Date, true>
  readonly opml: Feedsmith.Opml.Document<Date, readonly string[], true>
}

/** Formats available for subscription document generation. */
export type FeedFormat = keyof FeedData

/** Native generator options under the strict Feedsmith type contract. */
export interface FeedOptions {
  readonly rss: Omit<NonNullable<Parameters<typeof Feedsmith.generateRssFeed>[1]>, 'strict'>
  readonly atom: Omit<NonNullable<Parameters<typeof Feedsmith.generateAtomFeed>[1]>, 'strict'>
  readonly json: Omit<NonNullable<Parameters<typeof Feedsmith.generateJsonFeed>[1]>, 'strict'>
  readonly opml: Omit<NonNullable<Parameters<typeof Feedsmith.generateOpml>[1]>, 'strict'>
}

/** A publication endpoint whose format determines its native data and generator options. */
export type FeedConfig = {
  [F in FeedFormat]: {
    readonly format: F
    readonly path?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly options?: FeedOptions[F]
    readonly load: (ctx: Context) => FeedData[F] | Promise<FeedData[F]>
  }
}[FeedFormat]

/** Named publication endpoints with independently configured paths. */
export type FeedsConfig = Readonly<Record<string, FeedConfig>>

/** Complete publication policy, resolved before resources are created. */
export type ResolvedFeedConfig = FeedConfig & {
  readonly name: string
  readonly path: string
  readonly responseHeaders: Headers
}
