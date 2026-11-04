import { describe, expect, it } from 'vitest'

import { defineDatabase as definePostgres } from '../../src/entries/db/postgres'
import { createApp } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'

describe('Database & Resource Assembly Contract', () => {
  describe('PostgreSQL Database', () => {
    it('fails eagerly on connection failure during startup and cleans up client without leaking', async () => {
      // Connect to an invalid local port where no PostgreSQL server is running
      const dbDecl = definePostgres({
        url: 'postgres://localhost:54329/nonexistent',
        pool: { connectTimeout: 500 },
      })

      await expect(
        createApp(
          createDefinition({
            resources: { db: dbDecl },
          }),
        ),
      ).rejects.toThrow()
    })
  })
})
