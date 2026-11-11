import { HttpError, route, z } from '@olivaw/sark'
import { eq, or } from 'drizzle-orm'

import { posts } from '../db/schema'
import { canEditPost, setPostAttachments } from '../lib/posts'

export default route()
  .validate({
    params: z.object({
      id: z.string(),
    }),
    json: z.object({
      title: z.string().min(1),
      summary: z.string().optional(),
      content: z.string().min(1),
      status: z.enum(['draft', 'published']),
      scheduledAt: z.number().nullable().optional(),
      attachmentIds: z.array(z.string()).optional(),
    }),
  })
  .handler((c, { params, json }) => {
    const auth = c.var.auth
    const identity = auth.identity
    if (!identity?.sub) {
      throw new HttpError(401, 'Please log in to edit articles')
    }

    const db = c.var.db
    const existing = db
      .select()
      .from(posts)
      .where(or(eq(posts.id, params.id), eq(posts.slug, params.id)))
      .get()

    if (!existing) {
      throw new HttpError(404, 'Article not found')
    }

    if (!canEditPost(identity, existing.authorId)) {
      throw new HttpError(403, 'Permission denied: Not the original author')
    }

    const now = Date.now()
    const willBePublished = json.status === 'published' && existing.status !== 'published'
    const publishedAt = willBePublished
      ? now
      : json.status === 'published'
        ? existing.publishedAt || now
        : null
    const scheduledAt =
      json.status === 'published'
        ? null
        : json.scheduledAt === undefined && existing.status === 'draft'
          ? existing.scheduledAt
          : (json.scheduledAt ?? null)

    db.transaction((tx) => {
      tx.update(posts)
        .set({
          title: json.title,
          summary: json.summary || json.content.slice(0, 140),
          content: json.content,
          status: json.status,
          scheduledAt,
          publishedAt,
          updatedAt: now,
        })
        .where(eq(posts.id, existing.id))
        .run()

      if (json.attachmentIds !== undefined) {
        setPostAttachments(tx, existing.id, identity.sub, json.attachmentIds)
      }
    })

    return { success: true }
  })
