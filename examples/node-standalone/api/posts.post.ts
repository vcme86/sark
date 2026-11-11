import crypto from 'node:crypto'

import { HttpError, route, z } from '@olivaw/sark'

import { posts } from '../db/schema'
import { setPostAttachments } from '../lib/posts'

export default route()
  .validate({
    json: z.object({
      title: z.string().min(1, 'Title is required'),
      slug: z.string().optional(),
      summary: z.string().default(''),
      content: z.string().min(1, 'Content is required'),
      status: z.enum(['draft', 'published']).default('draft'),
      scheduledAt: z.number().nullable().optional(),
      attachmentIds: z.array(z.string()).optional(),
    }),
  })
  .handler((c, { json }) => {
    const auth = c.var.auth
    const identity = auth.identity
    if (!identity?.sub) {
      throw new HttpError(401, 'Please log in to create articles')
    }

    const db = c.var.db
    const now = Date.now()
    const id = `post_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const slug =
      json.slug?.trim() ||
      `${json.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}-${id.slice(-6)}`

    const publishedAt = json.status === 'published' ? now : null

    const newPost = {
      id,
      slug,
      title: json.title,
      summary: json.summary || json.content.slice(0, 140),
      content: json.content,
      status: json.status,
      authorId: identity.sub,
      scheduledAt: json.scheduledAt ?? null,
      publishedAt,
      createdAt: now,
      updatedAt: now,
    }

    db.transaction((tx) => {
      tx.insert(posts).values(newPost).run()
      if (json.attachmentIds && json.attachmentIds.length > 0) {
        setPostAttachments(tx, id, identity.sub, json.attachmentIds)
      }
    })

    return { post: newPost }
  })
