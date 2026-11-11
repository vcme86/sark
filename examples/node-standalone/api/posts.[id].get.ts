import { HttpError, route, z } from '@olivaw/sark'
import { eq, or } from 'drizzle-orm'

import { attachments, posts, users } from '../db/schema'
import { attachmentFields, canEditPost, postDisplay } from '../lib/posts'

export default route()
  .validate({
    params: z.object({
      id: z.string(),
    }),
  })
  .handler((c, { params }) => {
    const db = c.var.db
    const auth = c.var.auth
    const identity = auth.identity

    const post = db
      .select({
        id: posts.id,
        title: posts.title,
        summary: posts.summary,
        content: posts.content,
        authorId: posts.authorId,
        authorName: users.displayName,
        status: posts.status,
        scheduledAt: posts.scheduledAt,
        publishedAt: posts.publishedAt,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .innerJoin(users, eq(posts.authorId, users.id))
      .where(or(eq(posts.id, params.id), eq(posts.slug, params.id)))
      .get()

    if (!post) {
      throw new HttpError(404, 'Article not found')
    }

    // Check draft authorization
    if (post.status === 'draft') {
      if (!identity?.sub) {
        throw new HttpError(403, 'Authentication required to read unpublished drafts')
      }
    }

    const postAttachments = db
      .select(attachmentFields)
      .from(attachments)
      .where(eq(attachments.postId, post.id))
      .all()

    const { id, title, summary, content, authorName, authorId, ...dates } = post
    return {
      post: { id, title, summary, content, authorName, ...postDisplay(dates) },
      attachments: postAttachments,
      canEdit: canEditPost(identity, authorId),
    }
  })
