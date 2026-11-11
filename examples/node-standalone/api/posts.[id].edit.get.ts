import { HttpError, route, z } from '@olivaw/sark'
import { eq, or } from 'drizzle-orm'

import { attachments, posts } from '../db/schema'
import { attachmentFields, canEditPost } from '../lib/posts'

export default route()
  .validate({ params: z.object({ id: z.string() }) })
  .handler((c, { params }) => {
    const { db, auth } = c.var
    const identity = auth.identity
    if (!identity) throw new HttpError(401, 'Please log in to edit articles')

    const post = db
      .select({
        id: posts.id,
        slug: posts.slug,
        title: posts.title,
        summary: posts.summary,
        content: posts.content,
        status: posts.status,
        authorId: posts.authorId,
      })
      .from(posts)
      .where(or(eq(posts.id, params.id), eq(posts.slug, params.id)))
      .get()

    if (!post) throw new HttpError(404, 'Article not found')
    if (!canEditPost(identity, post.authorId)) {
      throw new HttpError(403, 'Permission denied: Not the original author')
    }

    const postAttachments = db
      .select(attachmentFields)
      .from(attachments)
      .where(eq(attachments.postId, post.id))
      .all()

    const { authorId: _, ...editorPost } = post
    return { post: editorPost, attachments: postAttachments }
  })
