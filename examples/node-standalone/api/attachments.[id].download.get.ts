import { HttpError, route, z } from '@olivaw/sark'
import { eq } from 'drizzle-orm'

import { attachments, posts } from '../db/schema'

export default route()
  .validate({
    params: z.object({
      id: z.string(),
    }),
  })
  .handler(async (c, { params }) => {
    const db = c.var.db
    const auth = c.var.auth
    const identity = auth.identity

    const attachment = db
      .select({
        postId: attachments.postId,
        ownerId: attachments.ownerId,
        filename: attachments.filename,
        storageKey: attachments.storageKey,
        postStatus: posts.status,
      })
      .from(attachments)
      .leftJoin(posts, eq(posts.id, attachments.postId))
      .where(eq(attachments.id, params.id))
      .get()

    if (!attachment) {
      throw new HttpError(404, 'Attachment not found')
    }

    if (attachment.postId === null && (!identity || identity.sub !== attachment.ownerId)) {
      throw new HttpError(403, 'Only the owner can download an unlinked attachment')
    }

    // Draft attachments follow the article's visibility.
    if (attachment.postStatus === 'draft' && !identity) {
      throw new HttpError(403, 'Authentication required to download attachments from drafts')
    }

    const storage = c.var.storage.uploads
    const stored = await storage.get(attachment.storageKey)

    if (!stored) {
      throw new HttpError(404, 'Physical attachment file missing from storage')
    }

    const headers = new Headers()
    headers.set('Content-Type', stored.contentType)
    headers.set('Content-Length', String(stored.size))
    if (attachment.postStatus !== 'published') headers.set('Cache-Control', 'private, no-store')

    // RFC 8187 excludes these characters even though encodeURIComponent leaves them literal.
    const filename = encodeURIComponent(attachment.filename).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)

    return new Response(stored.body, {
      status: 200,
      headers,
    })
  })
