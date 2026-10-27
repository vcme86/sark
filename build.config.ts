import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        'src/entries/server.ts',
        'src/entries/server/node.ts',
        'src/entries/http.ts',
        'src/entries/page.ts',
        'src/entries/client.ts',
        'src/entries/middleware.ts',
        'src/entries/utils.ts',
        'src/entries/vite.ts',
        'src/tooling/cli/index.ts',
        'src/entries/db/sqlite.ts',
        'src/entries/db/postgres.ts',
        'src/entries/db/d1.ts',
        'src/entries/runtime/core.ts',
        'src/entries/runtime/node.ts',
        'src/entries/runtime/cloudflare.ts',
        'src/entries/runtime/page-server.ts',
        'src/entries/runtime/page-browser.ts',
      ],
    },
  ],
})
