import crypto from 'node:crypto'
import { extname } from 'node:path'

import { HttpError, route, z } from '@olivaw/sark'

import { attachments } from '../db/schema'

export default route()
  .validate({
    form: z.strictObject({ file: z.instanceof(File) }),
  })
  .handler(async (c, { form }) => {
    const auth = c.var.auth
    const identity = auth.identity
    if (!identity?.sub) {
      throw new HttpError(401, 'Please log in to upload attachments')
    }

    const file = form.file

    const storage = c.var.storage.uploads
    const originalName = file.name || 'unnamed-attachment'
    const storageKey = `${crypto.randomUUID()}${extname(originalName)}`
    const { contentType, size } = await storage.put(storageKey, file.stream())

    const db = c.var.db
    const attachmentId = `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const now = Date.now()

    const record = {
      id: attachmentId,
      ownerId: identity.sub,
      filename: originalName,
      storageKey,
      contentType,
      size,
      createdAt: now,
    }

    db.insert(attachments).values(record).run()

    return {
      attachment: { id: attachmentId, filename: originalName, contentType, size },
    }
  })
