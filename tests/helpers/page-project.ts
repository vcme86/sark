import { createProject, viteEntry } from './project'

/** A fullstack fixture with independent page/API/resource prefixes and real CSS imports. */
export function createPageProject(target: 'node' | 'cloudflare') {
  const project = createProject()
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp({
  csrf: false,
  headers: { 'X-Application': 'sark' },
  cors: { origin: 'https://consumer.test' },
  middleware: [async (ctx, next) => { await next(); ctx.header('X-Business', 'executed') }],
})`,
  )
  project.write(
    'api/posts.[id].get.ts',
    `import { route } from '@olivaw/sark/server'
export default route().handler(ctx => ({ title: 'Post ' + ctx.req.param('id') }))`,
  )
  project.write(
    'api/save.post.ts',
    `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ saved: true }))`,
  )
  project.write(
    'app/_root.tsx',
    `import { Head, Outlet, Scripts } from '@olivaw/sark/client'
import './_global.css'
export default function Root() { return <html lang="en"><head><Head /></head><body><Outlet /><Scripts /></body></html> }`,
  )
  project.write('app/_global.css', 'body { color: rgb(12, 34, 56); }')
  project.write(
    'app/_error.tsx',
    `import type { ErrorProps } from '@olivaw/sark/page'
export default function ErrorPage({ error, retry }: ErrorProps) { return <main><h1>Page error {error.status}</h1><button onClick={retry}>Try again</button></main> }`,
  )
  project.write(
    'app/posts/[id].tsx',
    `import { Link, useAction, useBlocker, useNavigate } from '@olivaw/sark/client'
import { useState } from 'react'
import type { LoaderArgs, ActionArgs, MetaArgs } from '@olivaw/sark/page'
import styles from '../_post.module.css'
export async function loader({ client, params, signal }: LoaderArgs<{ id: string }>) {
  return client.get('/posts/:id', { params, init: { signal } })
}
export async function action({ client, signal }: ActionArgs) { return client.post('/save', { init: { signal } }) }
export function meta({ data }: MetaArgs<{ title: string }>) { return { title: data.title } }
export default function Page({ data }: { data: { title: string } }) {
  const [count, setCount] = useState(0)
  const [blocked, setBlocked] = useState(false)
  const result = useAction(action)
  const navigate = useNavigate()
  useBlocker(() => !blocked, blocked)
  return <main className={styles.post}>
    <h1>{data.title}</h1>
    <button onClick={() => setCount(count + 1)}>Count {count}</button>
    <Link to="/site/posts/2">Next post</Link>
    <Link to="/site/missing">Missing page</Link>
    <button onClick={() => { void navigate('/site/posts/3') }}>Third post</button>
    <button onClick={() => setBlocked(!blocked)}>Guard {blocked ? 'on' : 'off'}</button>
    <button disabled={result.pending} onClick={() => result.submit(new FormData())}>Save</button>
    {result.data !== undefined && <p>Saved</p>}
  </main>
}`,
  )
  project.write(
    'app/_post.module.css',
    ".post { background-color: rgb(240, 241, 242); background-image: url('./_texture.svg'); }",
  )
  project.write(
    'app/_texture.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="red" d="M0 0h2v2H0z"/></svg>',
  )
  project.write('files/read me#.txt', 'public resource')
  project.write('files/question?.txt', 'question resource')
  project.write('files/percent%.txt', 'percent resource')
  project.write('files/help.html', '<h1>Static help</h1>')
  project.write(
    'vite.config.mts',
    `import { sark } from ${JSON.stringify(viteEntry)}
import react from '@vitejs/plugin-react'
${target === 'cloudflare' ? "import { cloudflare } from '@cloudflare/vite-plugin'" : ''}
export default {
  base: '/resources', publicDir: 'files', cacheDir: '.build/vite-cache', build: { assetsInlineLimit: 0 },
  plugins: [sark({ target: '${target}', apiPrefix: '/service/v2', webPrefix: '/site' }), react()
    ${target === 'cloudflare' ? ", cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false })" : ''}],
}`,
  )
  if (target === 'cloudflare')
    project.write(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'sark-page-contract',
        main: '.build/worker.ts',
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        assets: { binding: 'ASSETS', run_worker_first: true, html_handling: 'none' },
      }),
    )
  return project
}
