import * as Feedsmith from 'feedsmith'
import { describe, expect, it, vi } from 'vitest'

import { getCurrentScope } from '../../src/app/context'
import { createApp } from '../../src/app/create'
import { createDefinition } from '../../src/app/definition'
import { defineFeeds, type FeedConfig } from '../../src/entries/feeds'
import { defineApp, route } from '../../src/entries/root'
import { createWorkerHandler } from '../../src/entries/runtime/cloudflare'
import { createFeedsAssembly } from '../../src/entries/runtime/feeds'
import { resolveFeedsConfig } from '../../src/features/feeds/config'
import { parseApiFilePath } from '../../src/http/path'
import * as fixtures from '../helpers/feeds'

const request = (path: string, method = 'GET') =>
  new Request(`https://request.example${path}`, { method })
const definition = (load: Extract<FeedConfig, { format: 'atom' }>['load'] = fixtures.atomData) =>
  createDefinition({
    services: { feeds: createFeedsAssembly(defineFeeds({ articles: { format: 'atom', load } })) },
  })

describe('native subscription delivery', () => {
  it('publishes all four generation formats with native fields, namespaces and content types', async () => {
    const app = await createApp(
      createDefinition({
        services: {
          feeds: createFeedsAssembly(
            defineFeeds({
              rss: { format: 'rss', load: fixtures.rssData },
              atom: { format: 'atom', load: fixtures.atomData },
              json: { format: 'json', load: fixtures.jsonData },
              opml: { format: 'opml', load: fixtures.opmlData },
            }),
          ),
        },
      }),
    )
    try {
      const rssResponse = await app.fetch(request('/feed.xml'))
      expect(rssResponse.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8')
      const rss = Feedsmith.parseRssFeed(await rssResponse.text())
      expect(rss.items?.[0]).toMatchObject({
        guid: { value: 'urn:uuid:article-1', isPermaLink: false },
        pubDate: fixtures.published.toUTCString(),
        content: { encoded: '<p>Full <b>article</b></p>' },
        authors: [{ name: 'Writer', email: 'writer@example.test' }],
        enclosures: [
          { url: 'https://media.example/download?id=1', type: 'audio/mpeg', length: 456 },
        ],
      })
      const response = await app.fetch(request('/feed.atom'))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-cache')
      const atom = Feedsmith.parseAtomFeed(await response.text())
      expect(atom).toMatchObject({
        id: 'urn:uuid:feed-1',
        title: { value: 'News & Notes' },
        updated: fixtures.updated.toISOString(),
        xml: { lang: 'en' },
      })
      expect(atom.entries).toHaveLength(1)
      expect(atom.entries![0]).toMatchObject({
        id: 'urn:uuid:article-1',
        updated: fixtures.updated.toISOString(),
        published: fixtures.published.toISOString(),
        title: { value: 'Audio & text' },
        content: { value: '<p>Full <b>article</b></p>', type: 'html' },
        contributors: [{ name: 'Reviewer' }],
        dc: { publishers: ['Application publisher'] },
        categories: [{ term: 'Engineering', scheme: 'https://tags.test' }],
      })
      expect(atom.entries![0].links).toEqual(fixtures.atomData().entries![0].links)
      expect(atom.generator).toBeUndefined()
      const json = await app.fetch(request('/feed.json'))
      expect(json.headers.get('content-type')).toBe('application/feed+json; charset=utf-8')
      expect(await json.json()).toMatchObject({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'News',
        items: [
          {
            id: 'article-1',
            content_text: 'Readable content',
            date_modified: fixtures.updated.toISOString(),
          },
        ],
      })
      const opml = await app.fetch(request('/subscriptions.opml'))
      expect(opml.headers.get('content-type')).toBe('text/x-opml; charset=utf-8')
      expect(Feedsmith.parseOpml(await opml.text()).body?.outlines).toEqual(
        fixtures.opmlData().body!.outlines,
      )
      expect(app).not.toHaveProperty('feeds')
    } finally {
      await app.close()
    }
  })

  it('uses only declared endpoints and executes global authorization before querying bound resources', async () => {
    const load = vi.fn(() => ({
      ...fixtures.atomData(),
      title: { value: getCurrentScope()!.resources!.title as string },
      entries: [],
    }))
    const app = await createApp(
      createDefinition({
        app: defineApp({
          middleware: [
            async (ctx, next) => {
              if (ctx.req.header('authorization') !== 'Reader') return ctx.text('Denied', 401)
              await next()
              ctx.header('X-Application', 'executed')
            },
          ],
        }),
        resources: { title: { createStatic: async () => ({ value: 'Bound resource' }) } },
        services: {
          feeds: createFeedsAssembly(
            defineFeeds({
              news: {
                format: 'atom',
                path: '/news.atom',
                headers: { 'Cache-Control': 'public, max-age=60' },
                load,
              },
            }),
          ),
        },
      }),
    )
    try {
      expect((await app.fetch(request('/news.atom'))).status).toBe(401)
      expect(load).not.toHaveBeenCalled()
      const authorized = (path: string, method = 'GET') =>
        app.fetch(
          new Request('https://request.example' + path, {
            method,
            headers: { authorization: 'Reader' },
          }),
        )
      const response = await authorized('/news.atom')
      expect(response.status).toBe(200)
      expect(response.headers.get('x-application')).toBe('executed')
      expect(response.headers.get('cache-control')).toBe('public, max-age=60')
      expect(Feedsmith.parseAtomFeed(await response.text()).title?.value).toBe('Bound resource')
      const head = await authorized('/news.atom', 'HEAD')
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      const post = await authorized('/news.atom', 'POST')
      expect(post.status).toBe(405)
      expect(post.headers.get('allow')).toContain('GET')
      for (const path of ['/feed.xml', '/feed.atom', '/feed.json', '/subscriptions.opml'])
        expect((await authorized(path)).status).toBe(404)
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      await app.close()
    }
  })

  it('resolves Node factories once and Workers factories separately for each event', async () => {
    let calls = 0
    const input = createDefinition({
      services: {
        feeds: createFeedsAssembly(
          defineFeeds((env: { title: string }) => {
            calls++
            return {
              news: {
                format: 'atom',
                load: () => ({ ...fixtures.atomData(), title: { value: env.title } }),
              },
            }
          }),
        ),
      },
    })
    const app = await createApp(input, { env: { title: 'Node' } })
    try {
      await app.fetch(request('/feed.atom'))
      await app.fetch(request('/feed.atom'))
      expect(calls).toBe(1)
    } finally {
      await app.close()
    }
    const worker = createWorkerHandler(input)
    for (const title of ['First', 'Second']) {
      const response = await worker.fetch(
        request('/feed.atom'),
        { title },
        { waitUntil() {}, passThroughOnException() {} },
      )
      expect(Feedsmith.parseAtomFeed(await response.text()).title?.value).toBe(title)
    }
    expect(calls).toBe(3)
  })

  it('detects endpoint collisions before resource creation', async () => {
    const create = vi.fn(async () => ({ value: {} }))
    for (const feeds of [
      defineFeeds({
        first: { format: 'atom', load: fixtures.atomData },
        second: { format: 'atom', load: fixtures.atomData },
      }),
      defineFeeds({ first: { format: 'atom', path: '/api/news', load: fixtures.atomData } }),
    ])
      await expect(
        createApp(
          createDefinition({
            services: { feeds: createFeedsAssembly(feeds) },
            resources: { test: { createStatic: create } },
            routes: [
              {
                routePath: parseApiFilePath('news.get.ts', '/api')!,
                declaration: route().handler(() => 'news'),
              },
            ],
          }),
        ),
      ).rejects.toThrow('Route conflict')
    expect(create).not.toHaveBeenCalled()
  })

  it('propagates query failure without publishing an empty subscription', async () => {
    const app = await createApp(
      definition(() => {
        throw new Error('Query unavailable')
      }),
    )
    try {
      const response = await app.fetch(request('/feed.atom'))
      expect(response.status).toBe(500)
      expect(response.headers.get('content-type')).not.toContain('atom+xml')
    } finally {
      await app.close()
    }
  })

  it('passes native generator options and custom OPML attributes through unchanged', async () => {
    const app = await createApp(
      createDefinition({
        services: {
          feeds: createFeedsAssembly(
            defineFeeds({
              list: {
                format: 'opml',
                options: { extraOutlineAttributes: ['owner'] },
                load: () => ({
                  body: {
                    outlines: [
                      {
                        text: 'News',
                        xmlUrl: 'https://feeds.example/feed.xml',
                        owner: 'Application',
                      },
                    ],
                  },
                }),
              },
            }),
          ),
        },
      }),
    )
    try {
      const response = await app.fetch(request('/subscriptions.opml'))
      const document = Feedsmith.parseOpml(await response.text(), {
        extraOutlineAttributes: ['owner'],
      })
      expect(document.body?.outlines?.[0].owner).toBe('Application')
    } finally {
      await app.close()
    }
  })

  it('does not serialize results after request cancellation', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let reads = 0
    const app = await createApp(
      definition(async () => {
        entered.resolve()
        await release.promise
        return {
          ...fixtures.atomData(),
          get title() {
            reads++
            return { value: 'Cancelled' }
          },
        }
      }),
    )
    try {
      const controller = new AbortController()
      const response = app.fetch(
        new Request('https://request.example/feed.atom', { signal: controller.signal }),
      )
      await entered.promise
      controller.abort()
      release.resolve()
      expect((await response).status).not.toBe(200)
      expect(reads).toBe(0)
    } finally {
      release.resolve()
      await app.close()
    }
  })
})

it.each([
  { format: 'unknown' },
  { format: 'atom', path: '/feed?x=1' },
  { format: 'atom', headers: { 'CONTENT-TYPE': 'application/json' } },
  { format: 'atom', headers: { Connection: 'close' } },
])('rejects invalid publication settings: %j', (input) => {
  const load = vi.fn(fixtures.atomData)
  expect(() => resolveFeedsConfig(defineFeeds({ news: { ...input, load } } as any), {})).toThrow()
  expect(load).not.toHaveBeenCalled()
})
