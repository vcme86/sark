import type { FeedData } from '../../src/entries/feeds'

export const updated = new Date('2026-11-01T12:00:00Z')
export const published = new Date('2026-10-30T09:00:00Z')

/** Native RSS fixture with stable GUID, HTML content, and an explicit media type. */
export function rssData(): FeedData['rss'] {
  return {
    title: 'News & Notes',
    link: 'https://content.example/articles',
    description: 'Public updates',
    lastBuildDate: updated,
    dc: { creators: ['Editor'] },
    items: [
      {
        title: 'Audio & text',
        link: 'https://content.example/articles/1?x=1&y=2',
        guid: { value: 'urn:uuid:article-1', isPermaLink: false },
        pubDate: published,
        content: { encoded: '<p>Full <b>article</b></p>' },
        authors: [{ name: 'Writer', email: 'writer@example.test' }],
        categories: [{ name: 'Engineering' }],
        enclosures: [
          { url: 'https://media.example/download?id=1', type: 'audio/mpeg', length: 456 },
        ],
      },
    ],
  }
}

/** Native Atom fixture with namespaced metadata and enclosure links. */
export function atomData(): FeedData['atom'] {
  return {
    id: 'urn:uuid:feed-1',
    title: { value: 'News & Notes' },
    updated,
    authors: [{ name: 'Editor' }],
    xml: { lang: 'en' },
    links: [{ href: 'https://feeds.example/feed.atom', rel: 'self' }],
    entries: [
      {
        id: 'urn:uuid:article-1',
        title: { value: 'Audio & text' },
        updated,
        published,
        summary: { value: '<p>Summary &amp; context</p>', type: 'html' },
        content: { value: '<p>Full <b>article</b></p>', type: 'html' },
        authors: [{ name: 'Writer', email: 'writer@example.test' }],
        contributors: [{ name: 'Reviewer' }],
        categories: [{ term: 'Engineering', scheme: 'https://tags.test' }],
        links: [
          { href: 'https://content.example/articles/1?x=1&y=2', rel: 'alternate' },
          {
            href: 'https://media.example/download?id=1',
            rel: 'enclosure',
            type: 'audio/mpeg',
            length: 456,
          },
        ],
        dc: { publishers: ['Application publisher'] },
      },
    ],
  }
}

/** Native JSON Feed fixture with a home URL and a dated text item. */
export function jsonData(): FeedData['json'] {
  return {
    title: 'News',
    home_page_url: 'https://content.example',
    items: [{ id: 'article-1', content_text: 'Readable content', date_modified: updated }],
  }
}

/** OPML fixture for a list of feed subscriptions. */
export function opmlData(): FeedData['opml'] {
  return {
    head: { title: 'Reading list' },
    body: { outlines: [{ text: 'News', type: 'rss', xmlUrl: 'https://feeds.example/feed.atom' }] },
  }
}
