import { route } from '@olivaw/sark'
import { eq } from 'drizzle-orm'

import { reports } from '../db/schema'

export default route().handler(async (c) => {
  const report = await c.var.db.select().from(reports).where(eq(reports.id, 1)).get()
  return { recordedAt: report?.recordedAt ?? null }
})
