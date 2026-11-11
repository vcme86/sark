import { HttpError, route, z } from '@olivaw/sark'
import { count, desc, eq } from 'drizzle-orm'

import { attachments, posts, users } from '../db/schema'
import { postDisplay } from '../lib/posts'

export default route()
  .validate({
    query: z.object({
      status: z.enum(['published', 'draft', 'all']).default('published'),
    }),
  })
  .handler((c, { query }) => {
    const db = c.var.db
    const auth = c.var.auth
    const identity = auth.identity

    const requestedStatus = query.status

    // If caller requests drafts or all, require authentication
    if (requestedStatus === 'draft' || requestedStatus === 'all') {
      if (!identity?.sub) {
        throw new HttpError(403, 'Authentication required to inspect draft articles')
      }
    }

    let filterCondition
    if (requestedStatus === 'published') {
      filterCondition = eq(posts.status, 'published')
    } else if (requestedStatus === 'draft') {
      filterCondition = eq(posts.status, 'draft')
    }

    const rows = db
      .select({
        id: posts.id,
        title: posts.title,
        summary: posts.summary,
        status: posts.status,
        scheduledAt: posts.scheduledAt,
        publishedAt: posts.publishedAt,
        createdAt: posts.createdAt,
        attachmentCount: count(attachments.id),
        authorName: users.displayName,
      })
      .from(posts)
      .innerJoin(users, eq(posts.authorId, users.id))
      .leftJoin(attachments, eq(attachments.postId, posts.id))
      .where(filterCondition)
      .groupBy(posts.id, users.id)
      .orderBy(desc(posts.createdAt))
      .all()

    return {
      posts: rows.map(({ id, title, summary, attachmentCount, authorName, ...dates }) => ({
        id,
        title,
        summary,
        authorName,
        attachmentCount,
        ...postDisplay(dates),
      })),
    }
  })
