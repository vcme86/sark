import { defineApp } from '@olivaw/sark'
import { defineAuth } from '@olivaw/sark/auth'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineJobs } from '@olivaw/sark/jobs'
import { defineStorage } from '@olivaw/sark/storage/local'
import { and, eq, isNotNull, lte } from 'drizzle-orm'

import { attachments, posts, users } from './db/schema'

export const app = defineApp({})

export const database = defineDatabase((env: NodeJS.ProcessEnv) => ({
  filename: env.DATABASE_FILE,
  schema: { users, posts, attachments },
}))

export const storage = {
  uploads: defineStorage((env: NodeJS.ProcessEnv) => ({
    dir: env.STORAGE_DIR ?? './data/uploads',
  })),
}

export const auth = defineAuth((env: NodeJS.ProcessEnv) => ({
  secret: env.AUTH_SECRET,
}))

export const jobs = defineJobs([
  {
    name: 'publish-scheduled-posts',
    schedule: { interval: 5000 },
    runOnInit: true,
    handler({ db, logger }) {
      const now = Date.now()
      const result = db
        .update(posts)
        .set({ status: 'published', publishedAt: now, updatedAt: now })
        .where(
          and(eq(posts.status, 'draft'), isNotNull(posts.scheduledAt), lte(posts.scheduledAt, now)),
        )
        .run()
      if (result.changes > 0)
        logger.info('Published {count} scheduled articles.', { count: result.changes })
    },
  },
])
