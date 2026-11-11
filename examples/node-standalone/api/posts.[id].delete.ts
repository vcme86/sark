import { getLogger, HttpError, route, z } from '@olivaw/sark'
import { eq, or } from 'drizzle-orm'

import { attachments, posts } from '../db/schema'
import { canEditPost } from '../lib/posts'

export default route()
  .validate({
    params: z.object({
      id: z.string(),
    }),
  })
  .handler(async (c, { params }) => {
    const auth = c.var.auth
    const identity = auth.identity
    if (!identity?.sub) {
      throw new HttpError(401, 'Please log in to delete articles')
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

    const attachedFiles = db.transaction((tx) => {
      const files = tx
        .select({ storageKey: attachments.storageKey })
        .from(attachments)
        .where(eq(attachments.postId, existing.id))
        .all()
      tx.delete(posts).where(eq(posts.id, existing.id)).run()
      return files
    })

    const storage = c.var.storage.uploads
    for (const file of attachedFiles) {
      try {
        await storage.delete(file.storageKey)
      } catch (error) {
        getLogger('attachments').warn('Failed to remove attachment {key}: {error}', {
          key: file.storageKey,
          error,
        })
      }
    }

    return { success: true }
  })
