/**
 * Pure isomorphic metadata merging and descriptor types.
 *
 * Shared by browser and server rendering; imports only descriptor types.
 *
 * @module
 */

import type { LinkDescriptor, MetaDescriptor, ScriptDescriptor } from './types'

/**
 * Merges descriptors in layout-to-page order; later values override matching earlier values.
 * Scalar fields and named social metadata override by field. Links and scripts replace
 * matching keys in place; distinct resource variants and unkeyed inline scripts remain ordered.
 *
 * @param descriptors - Ordered metadata, including any build-supplied stylesheet descriptor.
 * @returns Merged metadata without mutating the input descriptors.
 */
export function mergeMetaDescriptors(
  descriptors: readonly (MetaDescriptor | undefined)[],
): MetaDescriptor {
  let title: string | undefined
  let description: string | undefined
  let canonical: string | undefined
  let robots: string | undefined
  let openGraph: Record<string, string> | undefined
  let twitter: Record<string, string> | undefined
  const links: LinkDescriptor[] = []
  const scripts: ScriptDescriptor[] = []

  const linkPositions = new Map<string, number>()
  const scriptPositions = new Map<string, number>()

  for (const desc of descriptors) {
    if (!desc) continue
    if (desc.title !== undefined) title = desc.title
    if (desc.description !== undefined) description = desc.description
    if (desc.canonical !== undefined) canonical = desc.canonical
    if (desc.robots !== undefined) robots = desc.robots
    if (desc.openGraph !== undefined) {
      openGraph = { ...openGraph, ...desc.openGraph }
    }
    if (desc.twitter !== undefined) {
      twitter = { ...twitter, ...desc.twitter }
    }
    if (desc.links !== undefined) {
      for (const link of desc.links) {
        if (link.rel === 'canonical') {
          // Canonical links share the single canonical field instead of a separate list entry.
          canonical = link.href
          continue
        }

        let dedupeKey: string
        if (link.rel === 'manifest') {
          dedupeKey = 'manifest'
        } else if (link.key) {
          dedupeKey = `key:${link.key}`
        } else if (link.rel === 'stylesheet') {
          dedupeKey = `stylesheet:${link.href}:${link.type ?? ''}:${link.media ?? ''}`
        } else if (link.rel === 'preload' || link.rel === 'modulepreload') {
          dedupeKey = `${link.rel}:${link.href}:${link.as ?? ''}:${link.type ?? ''}:${link.media ?? ''}`
        } else if (link.rel === 'alternate') {
          dedupeKey = `alternate:${link.href}:${link.hreflang ?? ''}:${link.type ?? ''}:${link.media ?? ''}`
        } else {
          dedupeKey = `${link.rel}:${link.href}`
        }

        const position = linkPositions.get(dedupeKey)
        if (position === undefined) {
          linkPositions.set(dedupeKey, links.length)
          links.push(link)
        } else links[position] = link
      }
    }
    if (desc.scripts !== undefined) {
      for (const script of desc.scripts) {
        const key = script.key ?? script.src
        const position = key === undefined ? undefined : scriptPositions.get(key)
        if (position === undefined) {
          if (key !== undefined) scriptPositions.set(key, scripts.length)
          scripts.push(script)
        } else scripts[position] = script
      }
    }
  }

  return {
    title,
    description,
    canonical,
    robots,
    openGraph,
    twitter,
    links: links.length > 0 ? links : undefined,
    scripts: scripts.length > 0 ? scripts : undefined,
  }
}
