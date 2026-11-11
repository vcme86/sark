import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readNodeEnv } from '@olivaw/sark/runtime/node'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { databaseFile } from '../lib/data-paths.mjs'
import { hashPassword } from '../lib/password.mjs'

const env = readNodeEnv(process.cwd(), process.env.NODE_ENV ?? 'development')
const filename = resolve(databaseFile(env))
mkdirSync(dirname(filename), { recursive: true })

const sqlite = new Database(filename)
try {
  migrate(drizzle(sqlite), {
    migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)),
  })
  console.log(`Database migrations applied to ${filename}`)

  if (process.argv.includes('--demo')) {
    const seed = sqlite.transaction(() => {
      if (sqlite.prepare('SELECT id FROM users WHERE username = ?').get('admin')) return

      const now = Date.now()

      const userId = 'usr_admin_01'
      const passwordHash = hashPassword('admin123456')
      sqlite
        .prepare(
          `INSERT INTO users (id, username, password_hash, display_name, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, 'admin', passwordHash, 'Sarah Connor (Chief Editor)', 'admin', now)

      const post1Id = 'post_welcome_01'
      sqlite
        .prepare(
          `INSERT INTO posts (id, slug, title, summary, content, status, author_id, scheduled_at, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          post1Id,
          'welcome-to-ink-and-feather',
          'Welcome to Ink & Feather: Modern Publishing on Sark',
          'An introduction to Ink & Feather, demonstrating standalone full-stack Node.js deployment, typed client SSR, and seamless local storage.',
          `# Ink & Feather

Welcome to **Ink & Feather**, a clean and elegant content publishing showcase built on the [Sark](https://github.com/vcme86/sark) framework.

## What is demonstrated here?

- **SSR and hydration**: React 19 renders the initial page on the server and hydrates it in the browser for client-side navigation.
- **Typed Internal Client**: Isomorphic Loader calls the backend API with no internal HTTP loopback during SSR.
- **SQLite Persistence**: Local database powered by Drizzle ORM and SQLite, completely decoupled from build artifacts.
- **Local file storage**: Attachments are stored in a dedicated uploads directory and served through an application route that checks access.
- **Background Jobs**: Periodic scheduling checks and transitions scheduled drafts into published articles automatically.

Feel free to browse around, download attachments, or log in as an editor to compose new stories!`,
          'published',
          userId,
          null,
          now - 3600000,
          now - 3600000,
          now - 3600000,
        )

      const post2Id = 'post_draft_secret_02'
      sqlite
        .prepare(
          `INSERT INTO posts (id, slug, title, summary, content, status, author_id, scheduled_at, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          post2Id,
          'confidential-upcoming-roadmap',
          '[Draft] Confidential: 2027 Engineering Horizons',
          'A work-in-progress internal draft detailing upcoming architecture milestones.',
          `# Confidential: 2027 Engineering Horizons

> Note: This document is an unreleased draft. Anonymous visitors cannot view or download this content.

Here are the exploratory notes on next-generation edge deployment and state replication...`,
          'draft',
          userId,
          null,
          null,
          now - 1800000,
          now - 1800000,
        )
      console.log('Created the demo editor and articles.')
    })
    seed.immediate()
  }
} finally {
  sqlite.close()
}
