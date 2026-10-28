import { describe, expect, it } from 'vitest'

import { mergeMetaDescriptors } from '../../src/page/meta'

describe('page metadata merging', () => {
  it('correctly merges layout and page meta descriptors', () => {
    const layoutMeta = {
      title: 'Layout Title',
      description: 'Layout Description',
      openGraph: { site_name: 'Sark', type: 'website' },
      links: [{ rel: 'icon', href: '/favicon.ico' }],
    }

    const pageMeta = {
      title: 'Page Title', // Should override layout
      openGraph: { title: 'Page OG', type: 'article' }, // Shallow merge
      twitter: { card: 'summary_large_image' },
      links: [{ rel: 'canonical', href: 'https://example.com/page' }],
    }

    const merged = mergeMetaDescriptors([layoutMeta, pageMeta])
    expect(merged.title).toBe('Page Title')
    expect(merged.description).toBe('Layout Description')
    expect(merged.openGraph).toEqual({
      site_name: 'Sark',
      type: 'article',
      title: 'Page OG',
    })
    expect(merged.twitter).toEqual({ card: 'summary_large_image' })
    expect(merged.canonical).toBe('https://example.com/page')
    expect(merged.links).toEqual([{ rel: 'icon', href: '/favicon.ico' }])
  })

  it('deduplicates stylesheets and scripts and resolves canonical link in mergeMetaDescriptors', () => {
    const parentMeta = {
      title: 'Parent',
      links: [
        { rel: 'stylesheet', href: '/app.css' },
        { rel: 'canonical', href: 'https://example.com/parent' },
      ],
      scripts: [{ src: '/analytics.js', async: true }],
    }

    const childMeta = {
      title: 'Child',
      links: [
        { rel: 'stylesheet', href: '/app.css' }, // Duplicate stylesheet href
        { rel: 'stylesheet', href: '/child.css' },
        { rel: 'canonical', href: 'https://example.com/child' }, // Overrides canonical
      ],
      scripts: [
        { src: '/analytics.js', async: true }, // Duplicate script src
        { src: '/child.js' },
      ],
    }

    const merged = mergeMetaDescriptors([parentMeta, childMeta])
    expect(merged.title).toBe('Child')
    expect(merged.canonical).toBe('https://example.com/child')
    expect(merged.links).toEqual([
      { rel: 'stylesheet', href: '/app.css' },
      { rel: 'stylesheet', href: '/child.css' },
    ])
    expect(merged.scripts).toEqual([{ src: '/analytics.js', async: true }, { src: '/child.js' }])
  })
})

it('allows child metadata to replace the same explicit link key and singleton rel', () => {
  const meta = mergeMetaDescriptors([
    {
      links: [
        { key: 'icon', rel: 'icon', href: '/parent.ico' },
        { rel: 'manifest', href: '/parent.webmanifest' },
      ],
    },
    {
      links: [
        { key: 'icon', rel: 'icon', href: '/child.ico' },
        { rel: 'manifest', href: '/child.webmanifest' },
      ],
    },
  ])
  expect(meta.links).toEqual([
    { key: 'icon', rel: 'icon', href: '/child.ico' },
    { rel: 'manifest', href: '/child.webmanifest' },
  ])
})
