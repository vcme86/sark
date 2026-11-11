# Ink & Feather

A small publishing app that demonstrates Sark on a standalone Node.js server. It uses React SSR and hydration, first-party sessions, SQLite, local attachment storage, and a background job that publishes scheduled stories. Page loaders call the same typed API from the server and the browser.

## Setup

Use Node.js 26 and pnpm. From the Sark repository root:

```sh
pnpm install
pnpm build
cd examples/node-standalone
cp .env.example .env
```

Generate a session signing key and put it in `AUTH_SECRET` in `.env`:

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
```

Run `pnpm db:init` to apply the SQLite migrations. For a local walkthrough, run `pnpm db:seed` instead. It applies the migrations and creates sample articles and a demo editor (`admin` / `admin123456`). Use the seeded database for local testing.

By default, the app listens on port `3000` in production, stores SQLite data at `./data/app.db`, and saves attachments under `./data/uploads`. Override these with `PORT`, `DATABASE_FILE`, and `STORAGE_DIR` in `.env`.

## Development

```sh
pnpm dev
```

Open the URL printed by Vite. Run `pnpm typecheck` to regenerate Sark's declarations and type-check the app.

Anonymous visitors can read published stories and download their attachments. Editors can create stories, upload attachments, and schedule publication. An author or administrator can edit an existing story. The job checks for due drafts every five seconds. An unlinked upload is available only to its uploader. Once linked, the attachment follows the story's visibility.

## Production build

```sh
pnpm build
NODE_ENV=production pnpm db:init
pnpm start
```

Apply migrations against the persistent database before starting a new version. Keep the database and uploads outside `dist/` so that rebuilding or replacing the application does not affect stored data. The production entry is `dist/server.mjs`.
