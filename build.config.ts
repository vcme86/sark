import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        'src/entries/server.ts',
        'src/entries/server/node.ts',
        'src/entries/middleware.ts',
        'src/entries/http.ts',
        'src/entries/page.ts',
        'src/entries/client.ts',
        'src/entries/utils.ts',

        'src/entries/db/sqlite.ts',
        'src/entries/db/postgres.ts',
        'src/entries/db/d1.ts',

        'src/entries/auth/session.ts',
        'src/entries/auth/oauth.ts',

        'src/entries/auth/mfa.ts',
        'src/entries/auth/totp.ts',
        'src/entries/auth/totp-sqlite.ts',
        'src/entries/auth/totp-postgres.ts',
        'src/entries/auth/totp-d1.ts',
        'src/entries/auth/webauthn.ts',
        'src/entries/auth/webauthn-browser.ts',
        'src/entries/auth/webauthn-sqlite.ts',
        'src/entries/auth/webauthn-postgres.ts',
        'src/entries/auth/webauthn-d1.ts',
        'src/entries/auth/recovery-sqlite.ts',
        'src/entries/auth/recovery-postgres.ts',
        'src/entries/auth/recovery-d1.ts',
        'src/entries/auth/state-postgres.ts',
        'src/entries/auth/state-d1.ts',

        'src/entries/storage/local.ts',
        'src/entries/storage/s3.ts',
        'src/entries/storage/r2.ts',
        'src/entries/storage/presign.ts',
        'src/entries/assets/node.ts',

        'src/entries/visitors.ts',
        'src/entries/visitors/browser.ts',

        'src/entries/logging.ts',
        'src/entries/health.ts',
        'src/entries/jobs.ts',
        'src/entries/middleware/rate-limit.ts',

        'src/entries/vite.ts',
        'src/tooling/cli.ts',

        'src/entries/runtime/core.ts',
        'src/entries/runtime/node.ts',
        'src/entries/runtime/cloudflare.ts',
        'src/entries/runtime/page-server.ts',
        'src/entries/runtime/page-browser.ts',
        'src/entries/runtime/auth.ts',
        'src/entries/runtime/oauth.ts',
        'src/entries/runtime/mfa.ts',
        'src/entries/runtime/totp.ts',
        'src/entries/runtime/webauthn.ts',
        'src/entries/runtime/visitors.ts',
        'src/entries/runtime/jobs.ts',
      ],
    },
  ],
})
