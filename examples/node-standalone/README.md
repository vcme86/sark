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

Set `DATABASE_FILE` in `.env` for both the app and the database scripts. The example environment file sets it to `./data/app.db`. The production port defaults to `3000` and attachments default to `./data/uploads`. Set `PORT` or `STORAGE_DIR` in `.env` to override those defaults.

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

Password verification uses Node's shared worker pool. The example limits sign-in requests per source. For a public deployment, budget aggregate sign-in traffic against the capacity of that pool.

Behind a reverse proxy or load balancer, configure `trustedProxies` for the actual proxy addresses so sign-in limits are applied to clients. See the [deployment design](../../docs/design/deployment.md#反向代理与来源).
