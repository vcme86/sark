import { type Context, HttpError } from '@olivaw/sark'
import type { Identity } from '@olivaw/sark/auth'
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm'

import { attachments, type posts } from '../db/schema'

export const attachmentFields = {
  id: attachments.id,
  filename: attachments.filename,
  contentType: attachments.contentType,
  size: attachments.size,
}

export function canEditPost(identity: Identity | null | undefined, authorId: string): boolean {
  return !!identity && (identity.sub === authorId || identity.roles?.includes('admin') === true)
}

type Transaction = Parameters<Parameters<Context['var']['db']['transaction']>[0]>[0]

/** Replaces a post's attachments inside the transaction that saves the post. */
export function setPostAttachments(
  tx: Transaction,
  postId: string,
  userId: string,
  attachmentIds: readonly string[],
) {
  const ids = [...new Set(attachmentIds)]
  const linkedToPost = eq(attachments.postId, postId)

  if (ids.length > 0) {
    const { changes } = tx
      .update(attachments)
      .set({ postId })
      .where(
        and(
          inArray(attachments.id, ids),
          or(linkedToPost, and(isNull(attachments.postId), eq(attachments.ownerId, userId))),
        ),
      )
      .run()
    if (changes !== ids.length) throw new HttpError(403, 'One or more attachments are unavailable')
  }

  tx.update(attachments)
    .set({ postId: null })
    .where(ids.length === 0 ? linkedToPost : and(linkedToPost, notInArray(attachments.id, ids)))
    .run()
}

type PostDates = Pick<
  typeof posts.$inferSelect,
  'status' | 'scheduledAt' | 'publishedAt' | 'createdAt'
>

export function postDisplay(post: PostDates) {
  if (post.status === 'draft' && post.scheduledAt !== null) {
    return { status: 'scheduled' as const, date: post.scheduledAt }
  }
  return { status: post.status, date: post.publishedAt ?? post.createdAt }
}
