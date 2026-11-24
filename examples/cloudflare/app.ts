import { defineAuth } from '@olivaw/sark/auth'
import { defineDatabase } from '@olivaw/sark/db/d1'
import { defineJobs } from '@olivaw/sark/jobs'
import { defineStorage } from '@olivaw/sark/storage/r2'

import { reports } from './db/schema'

export const database = defineDatabase((env: Env) => ({
  binding: env.DB,
  schema: { reports },
}))

export const storage = {
  files: defineStorage((env: Env) => ({ binding: env.FILES })),
}

export const auth = defineAuth((env: Env) => ({ secret: env.AUTH_SECRET }))

export const jobs = defineJobs([
  {
    name: 'record-report',
    onCron: '0 * * * *',
    async handler({ db, storage: { files }, logger }) {
      const recordedAt = new Date().toISOString()
      await files.put('latest.txt', new Blob([recordedAt + '\n'], { type: 'text/plain' }), {
        overwrite: true,
      })
      await db
        .insert(reports)
        .values({ id: 1, recordedAt })
        .onConflictDoUpdate({ target: reports.id, set: { recordedAt } })
        .run()
      logger.info('Recorded report at {recordedAt}.', { recordedAt })
    },
  },
])
