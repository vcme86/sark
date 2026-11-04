import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        'src/entries/root.ts',
        'src/entries/node.ts',

        'src/entries/page.ts',
        'src/entries/page-cache.ts',
        'src/entries/client.ts',
        'src/entries/middleware.ts',

        'src/entries/db/sqlite.ts',
        'src/entries/db/postgres.ts',
        'src/entries/db/d1.ts',

        'src/entries/storage/local.ts',
        'src/entries/storage/s3.ts',
        'src/entries/storage/r2.ts',
        'src/entries/storage/presign.ts',

        'src/entries/auth.ts',
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

        'src/entries/logging.ts',

        'src/entries/jobs.ts',

        'src/entries/visitors.ts',

        'src/entries/stats.ts',
        'src/entries/stats/sqlite.ts',
        'src/entries/stats/postgres.ts',
        'src/entries/stats/d1.ts',

        'src/entries/vite.ts',
        'src/tooling/cli.ts',

        // Internal entries used only by generated applications.
        'src/entries/runtime/core.ts',
        'src/entries/runtime/node.ts',
        'src/entries/runtime/cloudflare.ts',

        'src/entries/runtime/page-server.ts',
        'src/entries/runtime/page-browser.ts',
        'src/entries/runtime/page-cache.ts',

        'src/entries/runtime/rate-limit.ts',

        'src/entries/runtime/auth.ts',
        'src/entries/runtime/oauth.ts',
        'src/entries/runtime/mfa.ts',
        'src/entries/runtime/totp.ts',
        'src/entries/runtime/webauthn.ts',

        'src/entries/runtime/storage.ts',

        'src/entries/runtime/logging.ts',
        'src/entries/runtime/health.ts',
        'src/entries/runtime/metrics.ts',

        'src/entries/runtime/jobs-node.ts',
        'src/entries/runtime/jobs-cloudflare.ts',

        'src/entries/runtime/visitors.ts',
        'src/entries/runtime/stats.ts',
      ],
    },
  ],
})
